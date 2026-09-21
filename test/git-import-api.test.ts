import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { GitImportService } from '../src/git/git-import-service.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import { GitRepositoryAccess } from '../src/git/git-repository-access.js';
import type { ApiCredential } from '../src/git/git-credential-provider.js';
import type { GitProvider, GitRepositoryInfo } from '../src/git/git-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';
import { createWebServer } from '../src/web/server/app.js';

const origin = 'https://deploy.example.com';
const password = 'git import api password';
const sha = '1'.repeat(40);

describe('Git private API route boundary', { timeout: 30_000 }, () => {
  it('owner 세션은 private inspect/refs를 실제 token으로 수행하고 public connection 없는 요청을 거부한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const connection = await fixture.server.sfudRuntime.gitConnections.save({
        ownerUserId: owner.userId, provider: 'gitlab', providerHost: 'gitlab.com', providerAccountId: 'owner-account',
        displayName: 'Owner GitLab', grantedPermissions: ['read_api', 'read_repository'], tokens: { accessToken: 'owner-api-token' },
      });
      const request = { provider: 'gitlab', repositoryPath: 'group/private-project', connectionId: connection.id } as const;

      const noConnection = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/inspect',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin },
        payload: { provider: request.provider, repositoryPath: request.repositoryPath }, });
      expect(noConnection.statusCode).toBe(400);
      expect(noConnection.json()).toMatchObject({ error: { code: 'GIT_CONNECTION_REQUIRED' } });

      const inspected = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/inspect',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin }, payload: request });
      expect(inspected.statusCode, inspected.body).toBe(200);
      expect(inspected.json()).toEqual({ repository: fixture.repository });
      expect(inspected.body).not.toContain('owner-api-token');
      expect(inspected.body).not.toContain('ownerUserId');
      expect(fixture.providerCalls.inspect).toEqual(['', 'owner-api-token']);

      const refs = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/refs',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin }, payload: { ...request, kind: 'branch' } });
      expect(refs.statusCode, refs.body).toBe(200);
      expect(refs.json()).toEqual({ refs: [{ kind: 'branch', name: 'main', commitSha: sha }] });
      expect(refs.body).not.toContain('owner-api-token');
      expect(fixture.providerCalls.refs).toEqual(['owner-api-token']);

      const missingCsrf = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/inspect',
        headers: { cookie: owner.cookie, origin }, payload: request });
      expect(missingCsrf.statusCode).toBe(403);
      const anonymous = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/refs', payload: { ...request, kind: 'branch' } });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await fixture.close();
    }
  });

  it('import 202 응답은 ref·SHA·status만 공개하고 타 사용자/VIEWER/CSRF 요청은 차단한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const otherSession = await fixture.server.sfudRuntime.auth.createManagedUser({
        actorUserId: owner.userId, email: 'other@example.com', displayName: 'Other', role: 'ADMIN', password,
      });
      const otherLogin = await fixture.server.sfudRuntime.auth.login(otherSession.email, password);
      const connection = await fixture.server.sfudRuntime.gitConnections.save({
        ownerUserId: owner.userId, provider: 'gitlab', providerHost: 'gitlab.com', providerAccountId: 'owner-import',
        displayName: 'Owner GitLab', grantedPermissions: ['read_api', 'read_repository'], tokens: { accessToken: 'import-secret-token' },
      });
      const request = {
        provider: 'gitlab', repositoryPath: 'group/private-project', connectionId: connection.id,
        ref: { kind: 'branch', name: 'main' }, expectedCommitSha: sha,
      };
      const created = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/imports',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin }, payload: request });
      expect(created.statusCode, created.body).toBe(202);
      const publicImport = created.json<{ import: Record<string, unknown> }>().import;
      expect(publicImport).toMatchObject({ provider: 'gitlab', repositoryPath: 'group/private-project', ref: request.ref, expectedCommitSha: sha });
      expect(publicImport).toHaveProperty('status');
      expect(JSON.stringify(publicImport)).not.toContain('import-secret-token');
      expect(JSON.stringify(publicImport)).not.toContain('ownerUserId');
      expect(JSON.stringify(publicImport)).not.toContain('pending');

      const importId = String(publicImport.id);
      const other = await fixture.server.inject({ method: 'GET', url: `/api/v1/git/imports/${importId}`,
        headers: { cookie: `sfud_session=${otherLogin.sessionToken}` } });
      expect(other.statusCode).toBe(404);
      await fixture.server.sfudRuntime.store.database.run("UPDATE users SET role = 'VIEWER' WHERE id = ?", owner.userId);
      const viewer = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/imports',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin }, payload: request });
      expect(viewer.statusCode).toBe(403);
      await fixture.server.sfudRuntime.store.database.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", owner.userId);
      const noCsrf = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/imports',
        headers: { cookie: owner.cookie, origin }, payload: request });
      expect(noCsrf.statusCode).toBe(403);
    } finally {
      await fixture.close();
    }
  });

  it('타 사용자 connectionId와 public private 저장소를 route에서 소유자 기준으로 거부한다', async () => {
    const fixture = await createFixture();
    try {
      const owner = await bootstrap(fixture.server);
      const other = await fixture.server.sfudRuntime.auth.createManagedUser({
        actorUserId: owner.userId, email: 'other-owner@example.com', displayName: 'Other owner', role: 'ADMIN', password,
      });
      const foreign = await fixture.server.sfudRuntime.gitConnections.save({
        ownerUserId: other.id, provider: 'gitlab', providerHost: 'gitlab.com', providerAccountId: 'foreign-account',
        displayName: 'Foreign GitLab', grantedPermissions: ['read_api', 'read_repository'], tokens: { accessToken: 'foreign-token' },
      });
      const request = { provider: 'gitlab', repositoryPath: 'group/private-project', connectionId: foreign.id };
      const inspect = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/inspect',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin }, payload: request });
      expect(inspect.statusCode).toBe(400);
      expect(inspect.json()).toMatchObject({ error: { code: 'GIT_CONNECTION_REQUIRED' } });
      expect(fixture.providerCalls.inspect).toEqual([]);

      const publicPrivate = await fixture.server.inject({ method: 'POST', url: '/api/v1/git/repositories/refs',
        headers: { cookie: owner.cookie, 'x-sfud-csrf': owner.csrfToken, origin },
        payload: { provider: 'gitlab', repositoryPath: 'group/private-project', kind: 'branch' }, });
      expect(publicPrivate.statusCode).toBe(400);
      expect(publicPrivate.json()).toMatchObject({ error: { code: 'GIT_CONNECTION_REQUIRED' } });
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-import-api-'));
  const keyPath = path.join(root, 'git-token.key');
  await writeFile(keyPath, Buffer.alloc(32, 29), { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const previousKey = process.env.SFUD_GIT_TOKEN_KEY_FILE;
  const previousVersion = process.env.SFUD_GIT_TOKEN_KEY_VERSION;
  process.env.SFUD_GIT_TOKEN_KEY_FILE = keyPath;
  process.env.SFUD_GIT_TOKEN_KEY_VERSION = '1';
  const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
    databasePath: path.join(root, 'sfud.db'), bootstrapToken: 'git-import-api-bootstrap', publicOrigin: origin });
  if (previousKey === undefined) delete process.env.SFUD_GIT_TOKEN_KEY_FILE;
  else process.env.SFUD_GIT_TOKEN_KEY_FILE = previousKey;
  if (previousVersion === undefined) delete process.env.SFUD_GIT_TOKEN_KEY_VERSION;
  else process.env.SFUD_GIT_TOKEN_KEY_VERSION = previousVersion;

  const address = normalizeRepository('group/private-project', 'gitlab');
  const repository: GitRepositoryInfo = { ...address, repositoryId: 'gitlab-42', private: true, defaultBranch: 'main' };
  const providerCalls = { inspect: [] as string[], refs: [] as string[], commits: [] as string[] };
  const tokenText = (token: string | ApiCredential | undefined) => token === undefined ? ''
    : typeof token === 'string' ? token : token.scheme === 'bearer' ? token.token : `${token.username}:${token.password}`;
  const provider: GitProvider = {
    id: 'gitlab',
    inspect: vi.fn(async (_address, token) => { providerCalls.inspect.push(tokenText(token)); return repository; }),
    listRefs: vi.fn(async (_repository, _kind, _cursor, token) => { providerCalls.refs.push(tokenText(token)); return { refs: [{ kind: 'branch' as const, name: 'main', commitSha: sha }] }; }),
    resolveCommit: vi.fn(async (_repository, _ref, token) => { providerCalls.commits.push(tokenText(token)); return sha; }),
  };
  const history = new GitImportRepository(server.sfudRuntime.store.database);
  const access = new GitRepositoryAccess(server.sfudRuntime.gitConnections, server.sfudRuntime.gitConnectionService, true);
  const service = new GitImportService(history, server.sfudRuntime.workspace.managedProjects, {
    providers: { github: provider, gitlab: provider, bitbucket: provider }, access,
    client: { fetch: async (options: GitFetchOptions) => { options.onDiskUsage(100); return objects(); } },
  });
  server.sfudRuntime.gitImports = service;
  server.sfudRuntime.workspace.gitImports = service;
  return {
    server, repository, providerCalls,
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

function objects(): GitObjectReader {
  const files = new Map<string, Buffer>([
    ['sfdx-project.json', Buffer.from('{"packageDirectories":[{"path":"force-app"}]}')],
    ['force-app/main/default/classes/Hello.cls', Buffer.from('public class Hello {}')],
  ]);
  return {
    async listTree() { return [...files].map(([file, content]) => ({ path: file, objectId: file, mode: '100644', type: 'blob', size: content.length })); },
    async readBlob(id) { return files.get(id)!; },
  };
}

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers: { origin }, payload: {
    bootstrapToken: 'git-import-api-bootstrap', email: 'owner@example.com', displayName: 'Owner', password,
  } });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ csrfToken: string; user: { id: string } }>();
  const cookies = response.headers['set-cookie'] as string[];
  return { userId: body.user.id, csrfToken: body.csrfToken, cookie: cookies.map((value) => value.split(';')[0]).join('; ') };
}
