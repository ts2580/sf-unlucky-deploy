import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitConnectionService } from '../src/git/git-connection-service.js';
import { GitRepositoryCatalog } from '../src/git/git-repository-catalog.js';
import type { GitProviderId } from '../src/git/git-repository.js';
import type { ProviderHttpClient, ProviderHttpOptions, ProviderHttpResponse } from '../src/git/git-network.js';
import { ProviderApi } from '../src/git/providers/provider-api.js';
import { TokenVault } from '../src/git/token-vault.js';
import { GitConnectionRepository } from '../src/storage/git-connection-repository.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository, type SfudUser } from '../src/storage/user-repository.js';
import { createWebServer } from '../src/web/server/app.js';

const password = 'correct horse battery staple';
const publicOrigin = 'https://deploy.example.com';

describe('Git provider repository catalog', { timeout: 30_000 }, () => {
  it('GitHub direct repository 목록을 page/search와 pull 권한으로 제한한다', async () => {
    const fixture = await databaseFixture();
    try {
      const connection = await fixture.save('github', 'github-token');
      const http = new MockHttp();
      const catalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(http));
      http.push({ status: 200, headers: {}, body: [
        { id: 100, full_name: 'acme/widget', permissions: { pull: true } },
        { id: 101, full_name: 'acme/private-no-pull', permissions: { pull: false } },
        { id: 102, full_name: 'acme/metadata-only', permissions: { metadata: 'read' } },
      ] });
      await expect(catalog.list(fixture.owner.id, connection.id, {})).resolves.toEqual({
        namespaces: [], repositories: [{ repositoryId: '100', repositoryPath: 'acme/widget' }],
      });
      expect(http.requests[0]).toMatchObject({
        url: 'https://api.github.com/user/repos?per_page=30&page=1&sort=full_name',
        options: { headers: { authorization: 'Bearer github-token' } },
      });
      http.push({ status: 200, headers: {}, body: [
        { id: 100, full_name: 'acme/widget', permissions: { pull: true } },
        { id: 101, full_name: 'acme/private-no-pull', permissions: { pull: false } },
      ] });
      await expect(catalog.list(fixture.owner.id, connection.id, { search: 'WIDGET' })).resolves.toEqual({
        namespaces: [], repositories: [{ repositoryId: '100', repositoryPath: 'acme/widget' }],
      });
      expect(http.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it('repository-bound 연결은 account REST 없이 고정된 한 저장소만 catalog로 노출한다', async () => {
    const fixture = await databaseFixture();
    try {
      const connection = await fixture.connections.save({
        ownerUserId: fixture.owner.id, provider: 'github', providerHost: 'github.com',
        providerAccountId: 'bound-account', displayName: 'Bound repository', grantedPermissions: [],
        repositoryPath: 'acme/widget', tokens: { accessToken: 'bound-token' },
      });
      const http = new MockHttp();
      const catalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(http));
      const listed = await catalog.list(fixture.owner.id, connection.id, {});
      expect(listed.namespaces).toEqual([]);
      expect(listed.repositories).toHaveLength(1);
      expect(listed.repositories[0]).toMatchObject({ repositoryPath: 'acme/widget' });
      expect(listed.repositories[0]!.repositoryId).toMatch(/^git:[0-9a-f]{64}$/u);
      await expect(catalog.list(fixture.owner.id, connection.id, { search: 'WIDGET' })).resolves.toEqual(listed);
      await expect(catalog.list(fixture.owner.id, connection.id, { search: 'missing' })).resolves.toEqual({ namespaces: [], repositories: [] });
      await expect(catalog.list(fixture.owner.id, connection.id, { namespace: 'acme' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
      await expect(catalog.list(fixture.owner.id, connection.id, { cursor: '2' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
      await expect(catalog.list(fixture.other.id, connection.id, {})).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
      expect(http.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('GitHub direct repositories와 GitLab projects의 page cursor를 안전하게 전달한다', async () => {
    const fixture = await databaseFixture();
    try {
      const github = await fixture.save('github', 'github-token');
      const githubHttp = new MockHttp();
      githubHttp.push({ status: 200, headers: {}, body: Array.from({ length: 30 }, (_, index) => ({
        id: index + 1, full_name: `team-${index}/repo`, permissions: { pull: true },
      })) });
      const githubCatalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(githubHttp));
      const githubPage = await githubCatalog.list(fixture.owner.id, github.id, {});
      expect(githubPage.repositories).toHaveLength(30);
      expect(githubPage.nextCursor).toBe('2');

      const gitlab = await fixture.save('gitlab', 'gitlab-token');
      const gitlabHttp = new MockHttp();
      gitlabHttp.push({ status: 200, headers: { 'x-next-page': '2' }, body: [
        { id: 7, path_with_namespace: 'group/sub/widget' },
        { id: 8, path_with_namespace: 'group/other' },
      ] });
      const gitlabCatalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(gitlabHttp));
      await expect(gitlabCatalog.list(fixture.owner.id, gitlab.id, { search: 'widget' })).resolves.toEqual({
        namespaces: [], repositories: [
          { repositoryId: '7', repositoryPath: 'group/sub/widget' },
          { repositoryId: '8', repositoryPath: 'group/other' },
        ], nextCursor: '2',
      });
      expect(gitlabHttp.requests[0]!.url).toBe('https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=30&page=1&order_by=id&sort=asc&search=widget');
      await expect(gitlabCatalog.list(fixture.owner.id, gitlab.id, { namespace: 'group' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
      await expect(gitlabCatalog.list(fixture.owner.id, gitlab.id, { cursor: '0' })).rejects.toMatchObject({ code: 'INVALID_REF' });
      expect(gitlabHttp.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('Bitbucket workspace와 권한 repository는 정확한 host/path/query cursor만 허용한다', async () => {
    const fixture = await databaseFixture();
    try {
      const connection = await fixture.save('bitbucket', 'bitbucket-token');
      const http = new MockHttp();
      const catalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(http));
      const workspaceNext = 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=30&page=2';
      http.push({ status: 200, headers: {}, body: {
        values: [
          { workspace: { slug: 'acme', name: 'Acme Workspace' } },
          { workspace: { slug: 'other_team', name: 'Other Team' } },
        ], next: workspaceNext,
      } });
      await expect(catalog.list(fixture.owner.id, connection.id, {})).resolves.toEqual({
        namespaces: [{ id: 'acme', name: 'Acme Workspace' }, { id: 'other_team', name: 'Other Team' }],
        repositories: [], nextCursor: workspaceNext,
      });
      expect(http.requests[0]!.options.headers?.authorization).toBe(`Basic ${Buffer.from('owner@example.com:bitbucket-token').toString('base64')}`);

      const repositoryNext = 'https://api.bitbucket.org/2.0/user/workspaces/acme/permissions/repositories?pagelen=30&q=repository.name%7E%22widget%22&page=2';
      http.push({ status: 200, headers: {}, body: {
        values: [
          { permission: 'read', repository: { uuid: '{repo-1}', full_name: 'acme/widget' } },
          { permission: 'none', repository: { uuid: '{repo-2}', full_name: 'acme/hidden' } },
        ], next: repositoryNext,
      } });
      await expect(catalog.list(fixture.owner.id, connection.id, { namespace: 'acme', search: 'widget' })).resolves.toEqual({
        namespaces: [], repositories: [{ repositoryId: '{repo-1}', repositoryPath: 'acme/widget' }], nextCursor: repositoryNext,
      });
      expect(http.requests[1]!.url).toBe('https://api.bitbucket.org/2.0/user/workspaces/acme/permissions/repositories?pagelen=30&q=repository.name%7E%22widget%22');
      await expect(catalog.list(fixture.owner.id, connection.id, { namespace: 'acme', cursor:
        'https://evil.test/2.0/user/workspaces/acme/permissions/repositories?pagelen=30&page=2' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
      for (const cursor of [
        `${repositoryNext}&access_token=attacker`,
        `${repositoryNext}&page=3&page=4`,
        'https://api.bitbucket.org/2.0/user/workspaces/acme/permissions/repositories?pagelen=20&page=2',
      ]) await expect(catalog.list(fixture.owner.id, connection.id, { namespace: 'acme', cursor })).rejects.toMatchObject({ code: 'INVALID_REF' });
      expect(http.requests).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it('연결 소유권·provider 설정·해제 중 tokenVersion을 다시 확인하고 비밀 필드를 반환하지 않는다', async () => {
    const fixture = await databaseFixture();
    try {
      const github = await fixture.save('github', 'owner-secret-token');
      const response = { status: 200, headers: {}, body: [{ id: 1, full_name: 'acme/widget', permissions: { pull: true } }] } satisfies ProviderHttpResponse;
      await expect(new GitRepositoryCatalog(fixture.connections, fixture.credentials, false, new ProviderApi(new MockHttp(response)))
        .list(fixture.owner.id, github.id, {})).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
      await expect(new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(new MockHttp(response)))
        .list(fixture.other.id, github.id, {})).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
      await fixture.connections.disconnect(fixture.owner.id, github.id);
      await expect(new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(new MockHttp(response)))
        .list(fixture.owner.id, github.id, {})).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });

      const serverFixture = await serverCatalogFixture();
      try {
        const auth = await bootstrap(serverFixture);
        const own = await serverFixture.save('github', 'route-secret-token', auth.userId);
        const other = await serverFixture.users.create({ email: 'other@example.com', displayName: 'Other', role: 'ADMIN' });
        const foreign = await serverFixture.save('github', 'foreign-secret-token', other.id);
        const http = new MockHttp(response);
        serverFixture.server.sfudRuntime.gitCatalog = new GitRepositoryCatalog(serverFixture.server.sfudRuntime.gitConnections,
        serverFixture.server.sfudRuntime.gitConnectionService, true, new ProviderApi(http));
        const listed = await serverFixture.server.inject({ url: `/api/v1/git/connections/${own.id}/repositories`, headers: { cookie: auth.cookie } });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json()).toEqual({ namespaces: [], repositories: [{ repositoryId: '1', repositoryPath: 'acme/widget' }] });
        expect(listed.body).not.toContain('route-secret-token');
        expect(listed.body).not.toContain('ownerUserId');
        const foreignResponse = await serverFixture.server.inject({ url: `/api/v1/git/connections/${foreign.id}/repositories`, headers: { cookie: auth.cookie } });
        expect(foreignResponse.statusCode).toBe(404);
        await serverFixture.server.sfudRuntime.store.database.run("UPDATE users SET role = 'VIEWER' WHERE id = ?", auth.userId);
        const viewerResponse = await serverFixture.server.inject({ url: `/api/v1/git/connections/${own.id}/repositories`, headers: { cookie: auth.cookie } });
        expect(viewerResponse.statusCode).toBe(403);
        await serverFixture.server.sfudRuntime.store.database.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", auth.userId);
        const malformed = await serverFixture.server.inject({ url: `/api/v1/git/connections/${own.id}/repositories?cursor=0`, headers: { cookie: auth.cookie } });
        expect(malformed.statusCode).toBe(400);
        expect(malformed.json()).toMatchObject({ error: { code: 'INVALID_REF' } });
        const anonymous = await serverFixture.server.inject({ url: `/api/v1/git/connections/${own.id}/repositories` });
        expect(anonymous.statusCode).toBe(401);
      } finally {
        await serverFixture.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it('provider 호출 중 연결이 해제되면 기존 API 결과를 폐기한다', async () => {
    const fixture = await databaseFixture();
    try {
      const connection = await fixture.save('github', 'race-token');
      const http = new MockHttp({ status: 200, headers: {}, body: [{ id: 1, full_name: 'acme/widget', permissions: { pull: true } }] });
      http.beforeResponse = async () => { await fixture.connections.disconnect(fixture.owner.id, connection.id); };
      const catalog = new GitRepositoryCatalog(fixture.connections, fixture.credentials, true, new ProviderApi(http));
      await expect(catalog.list(fixture.owner.id, connection.id, {})).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    } finally {
      await fixture.close();
    }
  });
});

class MockHttp implements ProviderHttpClient {
  public readonly requests: Array<{ url: string; options: ProviderHttpOptions }> = [];
  public beforeResponse: (() => Promise<void>) | undefined;
  private readonly responses: ProviderHttpResponse[] = [];

  public constructor(...responses: ProviderHttpResponse[]) { this.responses.push(...responses); }
  public push(response: ProviderHttpResponse): void { this.responses.push(response); }
  public async request(url: string, options: ProviderHttpOptions = {}): Promise<ProviderHttpResponse> {
    this.requests.push({ url, options });
    await this.beforeResponse?.();
    const response = this.responses.shift();
    if (response === undefined) throw new Error(`unexpected provider request: ${url}`);
    return response;
  }
}

async function databaseFixture() {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  const users = new UserRepository(store.database);
  const owner = await users.create({ email: 'owner@example.com', displayName: 'Owner', role: 'ADMIN' });
  const other = await users.create({ email: 'other-db@example.com', displayName: 'Other', role: 'ADMIN' });
  const vault = new TokenVault(new Map([[1, Buffer.alloc(32, 19)]]), 1);
  const connections = new GitConnectionRepository(store.database, vault);
  const credentials = new GitConnectionService(connections);
  return {
    store, users, owner, other, vault, connections, credentials,
    save: async (provider: GitProviderId, token: string, ownerUserId = owner.id) => connections.save({
      ownerUserId, provider, providerHost: provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org',
      providerAccountId: `${provider}-account-${ownerUserId}`, displayName: 'Catalog User', grantedPermissions: ['repo:read'],
      tokens: { accessToken: token, ...(provider === 'bitbucket' ? { apiUsername: 'owner@example.com' } : {}) },
    }),
    close: async () => store.close(),
  };
}

async function serverCatalogFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-catalog-route-'));
  const keyPath = path.join(root, 'git-token.key');
  await writeFile(keyPath, Buffer.alloc(32, 23), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const previousKey = process.env.SFUD_GIT_TOKEN_KEY_FILE;
  const previousVersion = process.env.SFUD_GIT_TOKEN_KEY_VERSION;
  process.env.SFUD_GIT_TOKEN_KEY_FILE = keyPath;
  process.env.SFUD_GIT_TOKEN_KEY_VERSION = '1';
  const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing', databasePath: ':memory:',
    bootstrapToken: 'catalog-route-bootstrap', publicOrigin });
  if (previousKey === undefined) delete process.env.SFUD_GIT_TOKEN_KEY_FILE;
  else process.env.SFUD_GIT_TOKEN_KEY_FILE = previousKey;
  if (previousVersion === undefined) delete process.env.SFUD_GIT_TOKEN_KEY_VERSION;
  else process.env.SFUD_GIT_TOKEN_KEY_VERSION = previousVersion;
  return {
    server,
    users: server.sfudRuntime.users,
    save: async (provider: GitProviderId, token: string, ownerUserId: string) => server.sfudRuntime.gitConnections.save({
      ownerUserId, provider, providerHost: provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org',
      providerAccountId: `${provider}-${ownerUserId}`, displayName: 'Route User', grantedPermissions: ['repo:read'], tokens: { accessToken: token, ...(provider === 'bitbucket' ? { apiUsername: 'owner@example.com' } : {}) },
    }),
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function bootstrap(fixture: Awaited<ReturnType<typeof serverCatalogFixture>>) {
  const response = await fixture.server.inject({ method: 'POST', url: '/api/v1/auth/bootstrap',
    headers: { origin: publicOrigin }, payload: { bootstrapToken: 'catalog-route-bootstrap', email: 'admin@example.com', displayName: 'Admin', password } });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ csrfToken: string; user: SfudUser }>();
  const cookies = response.headers['set-cookie'] as string[];
  return { userId: body.user.id, csrfToken: body.csrfToken, cookie: cookies.map((cookie) => cookie.split(';')[0]).join('; ') };
}
