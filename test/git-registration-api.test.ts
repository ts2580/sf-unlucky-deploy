import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { GitError } from '../src/git/git-errors.js';
import { normalizeRepository } from '../src/git/git-repository.js';

const request = { provider: 'github' as const, repositoryPath: 'owner/project', ref: { kind: 'branch' as const, name: 'main' }, expectedCommitSha: '1'.repeat(40), projectRoot: '.' };
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
      const roots = vi.spyOn(app.sfudRuntime.gitImports, 'projectRoots').mockResolvedValue({ projectRoots: ['.'], commitSha: request.expectedCommitSha, repositoryId: '1' });
      const warm = vi.spyOn(app.sfudRuntime.gitImports, 'warm').mockResolvedValue({ commitSha: '1'.repeat(40), syncedAt: '2026-09-21T00:00:00.000Z' });
      expect((await app.inject({ url: '/api/v1/git/registrations' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers: { cookie: headers.cookie }, payload: request })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers: { cookie: `sfud_session=${viewerAuth.sessionToken}`, 'x-sfud-csrf': viewerAuth.csrfToken }, payload: request })).statusCode).toBe(403);
      const discovery = { method: 'POST' as const, url: '/api/v1/git/project-roots', payload: request };
      expect((await app.inject(discovery)).statusCode).toBe(401);
      expect((await app.inject({ ...discovery, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
      expect((await app.inject({ ...discovery, headers: { cookie: `sfud_session=${viewerAuth.sessionToken}`, 'x-sfud-csrf': viewerAuth.csrfToken } })).statusCode).toBe(403);
      expect((await app.inject({ ...discovery, headers })).json()).toMatchObject({ projectRoots: ['.'], commitSha: request.expectedCommitSha });
      roots.mockResolvedValueOnce({ projectRoots: ['one', 'two'], commitSha: request.expectedCommitSha, repositoryId: '1' });
      const { projectRoot: _root, ...withoutRoot } = request;
      expect((await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers, payload: withoutRoot })).json().error.code).toBe('PROJECT_SELECTION_REQUIRED');
      const created = await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers, payload: request });
      expect(created.statusCode).toBe(201);
      const id = created.json().registration.id as string;
      const connectionId = '11111111-1111-4111-8111-111111111111';
      const db = app.sfudRuntime.store.database;
      await db.run(`INSERT INTO git_connections
        (id, owner_user_id, provider, provider_host, provider_account_id, display_name, alias,
         granted_permissions_json, status, key_version, created_at, updated_at)
        VALUES (?, ?, 'github', 'github.com', 'fixture-account', 'fixture', '처음 별칭', '[]', 'REAUTH_REQUIRED', 1, ?, ?)`,
      connectionId, auth.user.id, new Date().toISOString(), new Date().toISOString());
      const identities: string[] = [];
      for (const repositoryPath of ['team/billing', 'team/inventory']) {
        const registered = await app.sfudRuntime.gitRegistrations.register(auth.user.id, { ...request, connectionId, repositoryPath });
        identities.push(registered.id);
      }
      const accountSources = await app.sfudRuntime.gitRegistrations.sources(auth.user.id);
      expect(accountSources.filter((source) => identities.includes(source.id.slice('git-registered:'.length))).map((source) => source.label).sort())
        .toEqual(['처음 별칭 · team/billing · main', '처음 별칭 · team/inventory · main']);
      expect(accountSources.find((source) => source.id === `git-registered:${identities[0]}`)?.detail).toContain('github.com/team/billing · 프로젝트 .');
      for (const id of identities) await app.sfudRuntime.gitRegistrations.remove(id, auth.user.id);
      const linkedRequest = { ...request, connectionId };
      const linked = await app.inject({ method: 'POST', url: '/api/v1/git/registrations', headers, payload: linkedRequest });
      expect(linked.statusCode).toBe(201);
      const linkedId = linked.json().registration.id as string;
      const linkedLabel = async () => (await app.inject({ url: '/api/v1/workspace', headers })).json().sources
        .find((source: { id: string }) => source.id === `git-registered:${linkedId}`).label;
      expect(await linkedLabel()).toBe('처음 별칭 · owner/project · main');
      await app.inject({ method: 'PATCH', url: `/api/v1/git/connections/${connectionId}/alias`, headers, payload: { alias: '변경 별칭' } });
      expect(await linkedLabel()).toBe('변경 별칭 · owner/project · main');
      expect((await app.sfudRuntime.gitRegistrations.get(linkedId, auth.user.id)).request).toEqual(linkedRequest);
      await app.sfudRuntime.gitRegistrations.setAlias(linkedId, auth.user.id, '브랜치 별칭');
      expect(await linkedLabel()).toBe('브랜치 별칭 · main');
      await app.sfudRuntime.gitRegistrations.setAlias(linkedId, auth.user.id, '');
      await app.inject({ method: 'PATCH', url: `/api/v1/git/connections/${connectionId}/alias`, headers, payload: { alias: '' } });
      expect(await linkedLabel()).toBe('owner/project · main');
      await app.sfudRuntime.gitRegistrations.remove(linkedId, auth.user.id);
      warm.mockClear();
      const aliasUrl = `/api/v1/git/registrations/${id}/alias`;
      expect((await app.inject({ method: 'PATCH', url: aliasUrl, headers: { cookie: headers.cookie }, payload: { alias: '운영 소스' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: aliasUrl, headers: otherHeaders, payload: { alias: '운영 소스' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PATCH', url: aliasUrl, headers: { cookie: `sfud_session=${viewerAuth.sessionToken}`, 'x-sfud-csrf': viewerAuth.csrfToken }, payload: { alias: '운영 소스' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: aliasUrl, headers, payload: { alias: '  운영 소스  ' } })).json().registration)
        .toMatchObject({ alias: '운영 소스', request });
      expect(warm).not.toHaveBeenCalled();
      const workspace = await app.inject({ url: '/api/v1/workspace', headers });
      expect(workspace.json().sources).toContainEqual(expect.objectContaining({ id: `git-registered:${id}`, label: '운영 소스 · main' }));
      const types = await app.inject({ url: `/api/v1/metadata-types?sourceIds=git-registered:${id}`, headers });
      expect(types.json().metadataTypes).toContainEqual({ name: 'ApexClass', directoryName: 'classes' });
      expect((await app.inject({ url: '/api/v1/git/registrations', headers: otherHeaders })).json().registrations).toEqual([]);
      expect((await app.inject({ method: 'POST', url: `/api/v1/git/registrations/${id}/sync`, headers: otherHeaders })).statusCode).toBe(404);
      warm.mockRejectedValueOnce(new GitError('GIT_REMOTE_UNAVAILABLE'));
      expect((await app.inject({ method: 'POST', url: `/api/v1/git/registrations/${id}/sync`, headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/v1/git/registrations', headers })).json().registrations[0]).toMatchObject({ status: 'FAILED', lastCommitSha: '1'.repeat(40) });
      expect((await app.inject({ url: '/api/v1/git/registrations', headers })).json().registrations[0].alias).toBe('운영 소스');
      expect((await app.inject({ method: 'PATCH', url: aliasUrl, headers, payload: { alias: '' } })).json().registration.alias).toBeUndefined();
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/git/registrations/${id}`, headers })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/v1/git/registrations', headers })).json().registrations).toEqual([]);
    } finally { await app.close(); }
  });
});
