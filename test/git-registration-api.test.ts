import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { GitError } from '../src/git/git-errors.js';
import { normalizeRepository } from '../src/git/git-repository.js';

const request = { provider: 'github', repositoryPath: 'owner/project', ref: { kind: 'branch', name: 'main' }, expectedCommitSha: '1'.repeat(40), projectRoot: '.' };
describe('등록 브랜치 API', () => {
  it('세션·역할·CSRF·소유권을 검사하고 등록·동기화 실패·워크스페이스·삭제를 연결한다', async () => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, databasePath: ':memory:', bootstrapToken: 'fixture', assetsDirectory: '/missing',
      sfClient: { runJson: vi.fn(async () => ({ result: { nonScratchOrgs: [] } })) } });
    try {
      const auth = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const headers = { cookie: `sfud_session=${auth.sessionToken}`, 'x-sfud-csrf': auth.csrfToken };
      const other = await app.sfudRuntime.auth.createManagedUser({ actorUserId: auth.user.id, email: 'other@example.com', displayName: 'other', role: 'ADMIN', password: 'fixture-long-password' });
      const viewer = await app.sfudRuntime.auth.createManagedUser({ actorUserId: auth.user.id, email: 'viewer@example.com', displayName: 'viewer', role: 'VIEWER', password: 'fixture-long-password' });
      const viewerAuth = await app.sfudRuntime.auth.login(viewer.email, 'fixture-long-password');
      const otherAuth = await app.sfudRuntime.auth.login(other.email, 'fixture-long-password');
      const otherHeaders = { cookie: `sfud_session=${otherAuth.sessionToken}`, 'x-sfud-csrf': otherAuth.csrfToken };
      vi.spyOn(app.sfudRuntime.gitImports, 'inspect').mockResolvedValue({ ...normalizeRepository('owner/project', 'github'), repositoryId: '1', private: false });
      const warm = vi.spyOn(app.sfudRuntime.gitImports, 'warm').mockResolvedValue({ commitSha: '1'.repeat(40), syncedAt: '2026-09-21T00:00:00.000Z' });
      expect((await app.inject({ url: '/api/v1/git/registrations' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers: { cookie: headers.cookie }, payload: request })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers: { cookie: `sfud_session=${viewerAuth.sessionToken}`, 'x-sfud-csrf': viewerAuth.csrfToken }, payload: request })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers, payload: request });
      expect(created.statusCode).toBe(201);
      const id = created.json().registration.id as string;
      const workspace = await app.inject({ url: '/api/v1/workspace', headers });
      expect(workspace.json().sources).toContainEqual(expect.objectContaining({ id: `git-registered:${id}` }));
      const types = await app.inject({ url: `/api/v1/metadata-types?sourceIds=git-registered:${id}`, headers });
      expect(types.json().metadataTypes).toContainEqual({ name: 'ApexClass', directoryName: 'classes' });
      expect((await app.inject({ url: '/api/v1/git/registrations', headers: otherHeaders })).json().registrations).toEqual([]);
      expect((await app.inject({ method: 'POST', url: `/api/v1/git/registrations/${id}/sync`, headers: otherHeaders })).statusCode).toBe(404);
      warm.mockRejectedValueOnce(new GitError('GIT_REMOTE_UNAVAILABLE'));
      expect((await app.inject({ method: 'POST', url: `/api/v1/git/registrations/${id}/sync`, headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/v1/git/registrations', headers })).json().registrations[0]).toMatchObject({ status: 'FAILED', lastCommitSha: '1'.repeat(40) });
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/git/registrations/${id}`, headers })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/v1/git/registrations', headers })).json().registrations).toEqual([]);
    } finally { await app.close(); }
  });
});
