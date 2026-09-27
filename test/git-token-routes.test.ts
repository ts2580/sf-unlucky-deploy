import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderApi } from '../src/git/providers/provider-api.js';
import { GitTokenService } from '../src/git/git-token-service.js';
import { GitConnectionRepository } from '../src/storage/git-connection-repository.js';
import { TokenVault } from '../src/git/token-vault.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { createWebServer } from '../src/web/server/app.js';

const origin = 'https://deploy.example.com';
const password = 'correct horse battery staple';
const roots: string[] = [];
const initialTokenSecret = process.env.SFUD_GIT_TOKEN_SECRET;

afterEach(async () => {
  for (const name of ['SFUD_GIT_TOKEN_KEY_FILE', 'SFUD_GIT_TOKEN_KEY_VERSION', 'SFUD_GIT_TOKEN_SECRET']) delete process.env[name];
  if (initialTokenSecret !== undefined) process.env.SFUD_GIT_TOKEN_SECRET = initialTokenSecret;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Git PAT/API token 연결 라우트', { timeout: 30_000 }, () => {
  it('인증·역할·CSRF를 요구하고 provider identity를 검증한 뒤 owner별 연결을 반환한다', async () => {
    const fixture = await createFixture();
    try {
      expect((await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', payload: { provider: 'github', token: 'github-pat-secret' } })).statusCode).toBe(401);
      const owner = await bootstrap(fixture.server);
      const noCsrf = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: { cookie: owner.cookie }, payload: { provider: 'github', token: 'github-pat-secret' } });
      expect(noCsrf.statusCode).toBe(403);
      const malformed = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: { ...headers(owner), 'content-type': 'application/json' }, payload: '{"provider":"github","token":"malformed-secret' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain('malformed-secret');

      const viewerUser = await fixture.server.sfudRuntime.auth.createManagedUser({ actorUserId: owner.userId,
        email: 'viewer@example.com', displayName: 'Viewer', role: 'VIEWER', password });
      const viewer = await login(fixture.server, viewerUser.email);
      const forbidden = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(viewer), payload: { provider: 'github', token: 'github-pat-secret' } });
      expect(forbidden.statusCode).toBe(403);

      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'github', token: 'github-pat-secret' } });
      expect(created.statusCode, created.body).toBe(201);
      const connection = created.json<{ connection: { id: string; providerAccountId: string; displayName: string } }>().connection;
      expect(connection).toMatchObject({ providerAccountId: '42', displayName: 'octocat' });
      expect(created.body).not.toContain('github-pat-secret');

      const listed = await fixture.server.inject({ url: '/api/v1/git/connections', headers: { cookie: owner.cookie } });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain('github-pat-secret');
      expect(listed.json()).toMatchObject({ connections: [{ id: connection.id, provider: 'github' }], tokenStorage: 'ready' });
      const providers = await fixture.server.inject({ url: '/api/v1/git/providers', headers: { cookie: owner.cookie } });
      expect(providers.json()).toMatchObject({ environmentAvailable: false });
    } finally { await fixture.close(); }
  });

  it('Bitbucket email을 요구하고 replace는 같은 provider account만 허용한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const missingEmail = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'bitbucket', token: 'bitbucket-pat-secret' } });
      expect(missingEmail.statusCode).toBe(400);
      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: {
        provider: 'bitbucket', token: 'bitbucket-pat-secret', apiUsername: 'user@example.com', expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      } });
      expect(created.statusCode).toBe(201);
      const id = created.json<{ connection: { id: string } }>().connection.id;
      const mismatch = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: { provider: 'github', token: 'github-pat-secret' } });
      expect(mismatch.statusCode).toBe(404);
      const invalidExpiry = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: { provider: 'bitbucket', token: 'bitbucket-pat-secret', apiUsername: 'user@example.com', expiresAt: '2020-01-01T00:00:00.000Z' } });
      expect(invalidExpiry.statusCode).toBe(400);
      expect(fixture.apiCalls).toHaveLength(1);
      fixture.setBitbucketAccountId('{different-bb-uuid}');
      const sameProviderMismatch = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: { provider: 'bitbucket', token: 'bitbucket-pat-secret', apiUsername: 'user@example.com' } });
      expect(sameProviderMismatch.statusCode).toBe(404);
    } finally { await fixture.close(); }
  });

  it('provider 오류는 안전한 오류만 반환하고 실패한 token을 저장하지 않으며 key missing은 network를 호출하지 않는다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      fixture.setProviderStatus(500);
      const failed = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'github', token: 'provider-error-secret' } });
      expect(failed.statusCode).toBe(400);
      expect(failed.body).not.toContain('provider-error-secret');
      expect((await fixture.server.inject({ url: '/api/v1/git/connections', headers: { cookie: owner.cookie } })).json()).toMatchObject({ connections: [] });
      expect(fixture.apiCalls).toHaveLength(1);
    } finally { await fixture.close(); }

    const noKey = await createFixture({ key: false });
    try {
      const owner = await bootstrap(noKey.server);
      const response = await noKey.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'github', token: 'no-key-secret' } });
      expect(response.statusCode).toBe(400);
      expect(noKey.apiCalls).toHaveLength(0);
    } finally { await noKey.close(); }
  });

  it('/user token 검증의 403은 provider 계정 권한 오류로 구분하고 401·429도 보존한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      fixture.setProviderStatus(403);
      const inputs = [
        { provider: 'github', token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { provider: 'gitlab', token: 'glpat-AAAAAAAAAAAAAAAAAAAA' },
        { provider: 'bitbucket', token: 'ATBB-AAAAAAAAAAAAAAAAAAAA', apiUsername: 'user@example.com' },
      ] as const;
      const accountPermissionCodes = {
        github: 'GITHUB_ACCOUNT_PERMISSION_DENIED',
        gitlab: 'GITLAB_ACCOUNT_PERMISSION_DENIED',
        bitbucket: 'BITBUCKET_ACCOUNT_PERMISSION_DENIED',
      } as const;
      for (const input of inputs) {
        const response = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: input });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toEqual({ error: {
          code: accountPermissionCodes[input.provider],
          message: expect.stringContaining('계정 조회가 거부되었습니다.'),
        } });
        expect(response.body).not.toContain(input.token);
      }
      expect(fixture.apiCalls).toHaveLength(inputs.length);

      fixture.setProviderStatus(401);
      const unauthorized = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: inputs[0] });
      expect(unauthorized.statusCode).toBe(400);
      expect(unauthorized.json()).toMatchObject({ error: { code: 'GIT_REAUTH_REQUIRED' } });
      expect(unauthorized.body).not.toContain(inputs[0].token);

      fixture.setProviderStatus(429);
      const rateLimited = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: inputs[0] });
      expect(rateLimited.statusCode).toBe(429);
      expect(rateLimited.json()).toMatchObject({ error: { code: 'PROVIDER_RATE_LIMITED' } });
      expect(rateLimited.body).not.toContain(inputs[0].token);
    } finally { await fixture.close(); }
  });

  it('repository bound 연결은 세 provider의 Git 원격만 확인하고 Bitbucket 이메일·계정 API를 요구하지 않는다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const inputs = [
        { provider: 'github', token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repositoryPath: 'https://github.com/acme/github-project.git' },
        { provider: 'gitlab', token: 'glpat-AAAAAAAAAAAAAAAAAAAA', repositoryPath: 'https://gitlab.com/group/project.git' },
        { provider: 'bitbucket', token: 'ATBB-AAAAAAAAAAAAAAAAAAAA', repositoryPath: 'https://bitbucket.org/acme/project.git' },
      ] as const;
      for (const input of inputs) {
        const response = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: input });
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json()).toMatchObject({ connection: { provider: input.provider, repositoryPath: expect.stringContaining('project') } });
        expect(response.body).not.toContain(input.token);
      }
      expect(fixture.apiCalls).toEqual([]);
      expect(fixture.remoteCalls).toEqual(['acme/github-project', 'group/project', 'acme/project']);
    } finally { await fixture.close(); }
  });

  it('repository bound 교체는 같은 경로와 owner·CSRF를 요구하고 다른 경로를 거부한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: {
        provider: 'github', token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repositoryPath: 'owner/project',
      } });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json<{ connection: { id: string } }>().connection.id;
      const samePath = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: {
        provider: 'github', token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repositoryPath: 'owner/project',
      } });
      expect(samePath.statusCode, samePath.body).toBe(200);
      const otherPath = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: {
        provider: 'github', token: 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', repositoryPath: 'owner/other',
      } });
      expect(otherPath.statusCode).toBe(404);
      expect(otherPath.json()).toMatchObject({ error: { code: 'GIT_CONNECTION_REQUIRED' } });
      const otherUser = await fixture.server.sfudRuntime.auth.createManagedUser({ actorUserId: owner.userId,
        email: 'bound-other@example.com', displayName: 'Other', role: 'ADMIN', password });
      const other = await login(fixture.server, otherUser.email);
      const wrongOwner = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(other), payload: {
        provider: 'github', token: 'ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', repositoryPath: 'owner/project',
      } });
      expect(wrongOwner.statusCode).toBe(404);
      const missingCsrf = await fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: { cookie: owner.cookie }, payload: {
        provider: 'github', token: 'ghp_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', repositoryPath: 'owner/project',
      } });
      expect(missingCsrf.statusCode).toBe(403);
    } finally { await fixture.close(); }
  });

  it('환경 token은 지정된 owner만 불러오고 결과·오류에 secret을 노출하지 않는다', async () => {
    const fixture = await createFixture({ environment: {
      SFUD_GIT_TOKEN_OWNER_EMAIL: 'admin@example.com', SFUD_GITHUB_TOKEN: 'env-pat-secret',
      SFUD_BITBUCKET_TOKEN: 'bitbucket-pat-secret', SFUD_BITBUCKET_EMAIL: 'user@example.com',
    } });
    try {
      const owner = await bootstrap(fixture.server);
      const providers = await fixture.server.inject({ url: '/api/v1/git/providers', headers: { cookie: owner.cookie } });
      expect(providers.json()).toMatchObject({ environmentAvailable: true });
      const imported = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections/environment', headers: headers(owner) });
      expect(imported.json()).toMatchObject({ results: [
        { provider: 'github', connection: { providerAccountId: '42' } },
        { provider: 'bitbucket', connection: { providerAccountId: '{bb-uuid}' } },
      ] });
      expect(imported.body).not.toContain('env-pat-secret');

      const otherUser = await fixture.server.sfudRuntime.auth.createManagedUser({ actorUserId: owner.userId,
        email: 'other@example.com', displayName: 'Other', role: 'ADMIN', password });
      const other = await login(fixture.server, otherUser.email);
      const unavailable = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections/environment', headers: headers(other) });
      expect(unavailable.statusCode).toBe(404);
    } finally { await fixture.close(); }
  });

  it('환경 repository 설정은 세 provider를 Git 원격으로만 등록하고 Bitbucket 이메일 없이 유지한다', async () => {
    const fixture = await createFixture({ environment: {
      SFUD_GIT_TOKEN_OWNER_EMAIL: 'admin@example.com', SFUD_GITHUB_TOKEN: 'env-github-pat',
      SFUD_GITLAB_TOKEN: 'env-gitlab-pat', SFUD_BITBUCKET_TOKEN: 'env-bitbucket-token',
      SFUD_GITHUB_REPOSITORY: 'owner/github-project', SFUD_GITLAB_REPOSITORY: 'group/gitlab-project',
      SFUD_BITBUCKET_REPOSITORY: 'acme/bitbucket-project',
    } });
    try {
      const owner = await bootstrap(fixture.server);
      const imported = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections/environment', headers: headers(owner) });
      expect(imported.statusCode, imported.body).toBe(200);
      expect(imported.json()).toMatchObject({ results: [
        { provider: 'github', connection: { repositoryPath: 'owner/github-project' } },
        { provider: 'gitlab', connection: { repositoryPath: 'group/gitlab-project' } },
        { provider: 'bitbucket', connection: { repositoryPath: 'acme/bitbucket-project' } },
      ] });
      expect(imported.body).not.toContain('env-github-pat');
      expect(imported.body).not.toContain('env-gitlab-pat');
      expect(imported.body).not.toContain('env-bitbucket-token');
      expect(fixture.apiCalls).toEqual([]);
      expect(fixture.remoteCalls).toHaveLength(3);
    } finally { await fixture.close(); }
  });

  it('SECRET이 키 파일보다 우선하고 DB salt로 저장된 token을 재시작 뒤 읽는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-token-secret-priority-')); roots.push(root);
    const databasePath = path.join(root, 'data/sfud.db');
    const keyPath = path.join(root, 'legacy.key');
    await writeFile(keyPath, Buffer.alloc(32, 3), { mode: 0o600 });
    const secret = 'runtime-secret-value-'.repeat(2);
    const first = await createFixture({ databasePath, keyPath, secret });
    let owner: Awaited<ReturnType<typeof bootstrap>>;
    let connectionId: string;
    try {
      expect(first.server.sfudRuntime.gitTokenStorageStatus).toBe('ready');
      owner = await bootstrap(first.server);
      const created = await first.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: {
        provider: 'github', token: 'runtime-secret-token',
      } });
      expect(created.statusCode, created.body).toBe(201);
      connectionId = created.json<{ connection: { id: string } }>().connection.id;
    } finally { await first.close(); }
    const second = await createFixture({ databasePath, keyPath, secret });
    try {
      expect(second.server.sfudRuntime.gitTokenStorageStatus).toBe('ready');
      const parameters = await second.server.sfudRuntime.store.database.get<{ salt: string }>(
        'SELECT salt FROM git_token_key_parameters WHERE id = 1');
      expect(parameters?.salt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const secretVault = await TokenVault.fromSecret(secret, Buffer.from(parameters!.salt, 'base64url'));
      const credentials = await new GitConnectionRepository(second.server.sfudRuntime.store.database, secretVault)
        .readCredentials(owner!.userId, connectionId!);
      expect(credentials.tokens.accessToken).toBe('runtime-secret-token');
      await expect(second.server.sfudRuntime.gitConnections.readCredentials(owner!.userId, connectionId!))
        .resolves.toMatchObject({ tokens: { accessToken: 'runtime-secret-token' } });
    } finally { await second.close(); }
    const corruptedStore = await openSqliteStore({ databasePath });
    await corruptedStore.database.run('UPDATE git_token_key_parameters SET salt = ? WHERE id = 1', 'corrupted-salt');
    await corruptedStore.close();
    const corrupted = await createFixture({ databasePath, keyPath, secret });
    try {
      expect(corrupted.server.sfudRuntime.gitTokenStorageStatus).toBe('invalid_key');
    } finally { await corrupted.close(); }
  });

  it('repository bound 연결은 재시작 뒤에도 경로와 암호화 자격 증명을 유지한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-bound-restart-')); roots.push(root);
    const databasePath = path.join(root, 'data/sfud.db');
    const first = await createFixture({ databasePath });
    let owner: Awaited<ReturnType<typeof bootstrap>>;
    let connectionId: string;
    try {
      owner = await bootstrap(first.server);
      const created = await first.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: {
        provider: 'github', token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', repositoryPath: 'owner/project',
      } });
      expect(created.statusCode, created.body).toBe(201);
      connectionId = created.json<{ connection: { id: string } }>().connection.id;
    } finally { await first.close(); }
    const second = await createFixture({ databasePath });
    try {
      const listed = await second.server.inject({ url: '/api/v1/git/connections', headers: { cookie: owner!.cookie } });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ connections: [{ id: connectionId!, repositoryPath: 'owner/project' }] });
      await expect(second.server.sfudRuntime.gitConnections.readCredentials(owner!.userId, connectionId!))
        .resolves.toMatchObject({ tokens: { accessToken: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } });
    } finally { await second.close(); }
  });

  it('빈 값·잘못된 SECRET은 invalid_key로 닫히며 기존 키 파일로 fallback하지 않는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-token-secret-invalid-')); roots.push(root);
    const keyPath = path.join(root, 'legacy.key');
    await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    for (const secret of ['', 'too-short']) {
      const fixture = await createFixture({ keyPath, secret });
      try {
        expect(fixture.server.sfudRuntime.gitTokenStorageStatus).toBe('invalid_key');
        expect(fixture.server.sfudRuntime.gitTokenStorageStatus).not.toBe('ready');
      } finally { await fixture.close(); }
    }
  });

  it('연결 해제는 CSRF·owner를 확인하고 로컬 자격 증명을 제거한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'github', token: 'github-pat-secret' } });
      const id = created.json<{ connection: { id: string } }>().connection.id;
      const otherUser = await fixture.server.sfudRuntime.auth.createManagedUser({ actorUserId: owner.userId,
        email: 'other@example.com', displayName: 'Other', role: 'ADMIN', password });
      const other = await login(fixture.server, otherUser.email);
      expect((await fixture.server.inject({ method: 'DELETE', url: `/api/v1/git/connections/${id}`, headers: headers(other) })).statusCode).toBe(404);
      expect((await fixture.server.inject({ method: 'DELETE', url: `/api/v1/git/connections/${id}`, headers: { cookie: owner.cookie } })).statusCode).toBe(403);
      expect((await fixture.server.inject({ method: 'DELETE', url: `/api/v1/git/connections/${id}`, headers: headers(owner) })).statusCode).toBe(204);
      expect((await fixture.server.inject({ url: '/api/v1/git/connections', headers: { cookie: owner.cookie } })).json()).toMatchObject({ connections: [] });
      const row = await fixture.server.sfudRuntime.store.database.get('SELECT encrypted_access_token, encrypted_api_username, status FROM git_connections WHERE id = ?', id);
      expect(row).toEqual({ encrypted_access_token: null, encrypted_api_username: null, status: 'REVOKED' });
    } finally { await fixture.close(); }
  });

  it('PUT 검증 중 disconnect가 먼저 끝나면 늦은 replace가 연결을 되살리지 않는다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/connections', headers: headers(owner), payload: { provider: 'github', token: 'github-pat-secret' } });
      const id = created.json<{ connection: { id: string } }>().connection.id;
      const gate = fixture.blockNextProviderCall();
      const replacing = fixture.server.inject({ method: 'PUT', url: `/api/v1/git/connections/${id}`, headers: headers(owner), payload: { provider: 'github', token: 'github-pat-secret' } });
      await gate.started;
      expect((await fixture.server.inject({ method: 'DELETE', url: `/api/v1/git/connections/${id}`, headers: headers(owner) })).statusCode).toBe(204);
      gate.release();
      const replaced = await replacing;
      expect([400, 404]).toContain(replaced.statusCode);
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT status, encrypted_access_token FROM git_connections WHERE id = ?', id))
        .toEqual({ status: 'REVOKED', encrypted_access_token: null });
    } finally { await fixture.close(); }
  });
});

async function createFixture(options: { environment?: NodeJS.ProcessEnv; key?: boolean; databasePath?: string; keyPath?: string; secret?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-token-routes-')); roots.push(root);
  const keyPath = options.keyPath ?? path.join(root, 'git-token.key');
  if (options.secret === undefined) delete process.env.SFUD_GIT_TOKEN_SECRET;
  else process.env.SFUD_GIT_TOKEN_SECRET = options.secret;
  if (options.key !== false) {
    await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 }); await chmod(keyPath, 0o600);
    process.env.SFUD_GIT_TOKEN_KEY_FILE = keyPath; process.env.SFUD_GIT_TOKEN_KEY_VERSION = '1';
  } else {
    delete process.env.SFUD_GIT_TOKEN_KEY_FILE; delete process.env.SFUD_GIT_TOKEN_KEY_VERSION;
  }
  const server = await createWebServer({ host: '127.0.0.1', port: 0, assetsDirectory: '/missing', databasePath: options.databasePath ?? ':memory:', bootstrapToken: 'git-token-bootstrap', publicOrigin: origin });
  let providerStatus = 200;
  let githubAccountId = 42;
  let bitbucketAccountId = '{bb-uuid}';
  let blockNext = false;
  let startedResolve: (() => void) | undefined;
  let releaseResolve: (() => void) | undefined;
  const apiCalls: string[] = [];
  const remoteCalls: string[] = [];
  const responses = (url: string) => url.includes('bitbucket')
    ? { uuid: bitbucketAccountId, display_name: 'Bitbucket User' }
    : url.includes('gitlab') ? { id: 43, username: 'gitlab-user' } : { id: githubAccountId, login: githubAccountId === 42 ? 'octocat' : 'different-user' };
  const api = new ProviderApi({ request: async (url) => {
    apiCalls.push(url);
    if (blockNext) {
      blockNext = false;
      startedResolve?.();
      await new Promise<void>((resolve) => { releaseResolve = resolve; });
    }
    return { status: providerStatus, headers: { 'x-oauth-scopes': 'repo,read_api' }, body: responses(url) };
  } });
  const remote = { lsRemote: vi.fn(async (options: { repository: { repositoryPath: string } }) => {
    remoteCalls.push(options.repository.repositoryPath);
    return Buffer.from(`ref: refs/heads/main\tHEAD\n${'a'.repeat(40)}\trefs/heads/main\n`);
  }) };
  const environment = { ...(options.environment ?? {}) };
  if (options.key !== false) server.sfudRuntime.gitTokens = new GitTokenService(server.sfudRuntime.gitConnections, api, true, environment, remote);
  return {
    server, apiCalls, remoteCalls,
    setProviderStatus: (value: number) => { providerStatus = value; },
    setGithubAccountId: (value: string) => { githubAccountId = Number(value); },
    setBitbucketAccountId: (value: string) => { bitbucketAccountId = value; },
    blockNextProviderCall: () => {
      blockNext = true;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      return { started, release: () => releaseResolve?.() };
    },
    close: async () => server.close(),
  };
}

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin }, payload: {
    bootstrapToken: 'git-token-bootstrap', email: 'admin@example.com', displayName: 'Admin', password,
  } });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  const cookies = response.headers['set-cookie'] as string[];
  return { cookie: cookies.map((value) => value.split(';')[0]).join('; '), csrfToken: body.csrfToken, userId: body.user.id };
}

async function login(server: Awaited<ReturnType<typeof createWebServer>>, email: string) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email, password } });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  const cookies = response.headers['set-cookie'] as string[];
  return { cookie: cookies.map((value) => value.split(';')[0]).join('; '), csrfToken: body.csrfToken, userId: body.user.id };
}

function headers(auth: { cookie: string; csrfToken: string }) { return { cookie: auth.cookie, origin, 'x-sfud-csrf': auth.csrfToken }; }
