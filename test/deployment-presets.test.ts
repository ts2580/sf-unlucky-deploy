import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { resolvePreset, captureSelection } from '../src/web/server/deployment-selection-resolver.js';
import type { WebRuntime } from '../src/web/server/runtime.js';
import type { DeploymentSelection } from '../src/api/deployment-preset-contracts.js';
const selection: DeploymentSelection = { sourceId: 'org:source', targetId: 'org:target', compareCurrentType: true, showIdentical: false, metadataType: 'ApexClass', excludedPackageIds: [], testLevel: 'auto', tests: [] };
describe('deployment presets', () => {
  it('CRUD is owned, CSRF/role protected and survives restart; alias identity replacement cannot resolve', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-presets-'));
    let targetOrgId = '00D000000000002';
    const options = { host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'), assetsDirectory: '/missing', bootstrapToken: 'fixture',
      sfClient: { runJson: async () => ({ result: { nonScratchOrgs: ['source', 'target'].map((alias) => ({ alias, username: `${alias}@example.com`, orgId: alias === 'target' ? targetOrgId : '00D000000000001', connectedStatus: 'Connected' })) } }) } };
    let app = await createWebServer(options);
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const headers = { cookie: `sfud_session=${owner.sessionToken}`, 'x-sfud-csrf': owner.csrfToken };
      const viewer = await app.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id, email: 'viewer@example.com', displayName: 'viewer', role: 'VIEWER', password: 'fixture-long-password' });
      const other = await app.sfudRuntime.auth.login(viewer.email, 'fixture-long-password');
      const otherHeaders = { cookie: `sfud_session=${other.sessionToken}`, 'x-sfud-csrf': other.csrfToken };
      const url = '/api/v1/deployment-presets'; const payload = { name: '개발 서버 반영', selection };
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: otherHeaders, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, token: 'secret' } })).statusCode).toBe(400);
      const created = await app.inject({ method: 'POST', url, headers, payload });
      expect(created.statusCode, created.body).toBe(201); const id = created.json().id;
      expect((await app.inject({ url, headers: otherHeaders })).json()).toEqual({ presets: [] });
      expect((await app.inject({ url: `${url}/${id}/resolve`, headers: otherHeaders })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers: otherHeaders })).statusCode).toBe(403);
      expect((await app.inject({ url: `${url}/${id}/resolve`, headers })).json().selection).toMatchObject(selection);
      await app.close(); app = await createWebServer(options);
      expect((await app.inject({ url, headers })).json().presets[0].id).toBe(id);
      expect((await app.inject({ method: 'PUT', url: `${url}/${id}`, headers, payload: { ...payload, name: '변경' } })).statusCode).toBe(200);
      targetOrgId = '00D000000000003';
      expect((await app.inject({ url: `${url}/${id}/resolve`, headers })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `${url}/${id}`, headers })).statusCode).toBe(204);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('captures confirmed projectRoot rather than omitted import request and never imports on resolve', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'READY', provider: 'github', repositoryPath: 'https://github.com/team/repo', ref: { kind: 'branch', name: 'main' }, expectedCommitSha: 'a'.repeat(40), provenance: { repositoryId: '42', commitSha: 'a'.repeat(40), projectRoot: 'nested', metadataType: 'ApexClass' }, metadataType: 'ApexClass' });
    const imports = { get, inspect: vi.fn().mockResolvedValue({ repositoryId: '42' }), refs: vi.fn().mockResolvedValue({ refs: [{ name: 'main', commitSha: 'b'.repeat(40) }] }), projectRoots: vi.fn().mockResolvedValue({ projectRoots: ['nested'] }), prepareLatest: vi.fn() };
    const runtime = { gitImports: imports, workspace: { getOrgIdentity: vi.fn().mockResolvedValue({ alias: 'target', orgId: '00D1', username: 'target@example.com' }), publicSource: (id: string) => ({ id, kind: 'org', label: 'target' }) } } as unknown as WebRuntime;
    const settings = await captureSelection(runtime, 'owner', { ...selection, sourceId: 'git:ephemeral' });
    expect(settings.source).toMatchObject({ kind: 'git', request: { projectRoot: 'nested' } });
    expect(JSON.stringify(settings)).not.toContain('ephemeral');
    runtime.presets = { get: vi.fn().mockResolvedValue({ preset: { id: 'saved', name: 'test', schemaVersion: 1, createdAt: '', updatedAt: '' }, settings }) } as unknown as WebRuntime['presets'];
    const result = await resolvePreset(runtime, 'owner', 'saved');
    expect(result.selection).toBeUndefined(); expect(result.preparationRequired).toBe(true);
    expect(imports.prepareLatest).not.toHaveBeenCalled(); expect(result.warnings).toHaveLength(1);
    imports.projectRoots.mockResolvedValueOnce({ projectRoots: ['different'] });
    await expect(resolvePreset(runtime, 'owner', 'saved')).rejects.toThrow('프로젝트 경로');
  });
});

describe('deployment selection drafts', () => {
  it('draft TTL, per-tab limits and receive-order CAS preserve new selections without touching jobs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-drafts-'));
    const app = await createWebServer({ host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'), assetsDirectory: '/missing', bootstrapToken: 'fixture', sfClient: { runJson: async () => ({ result: { nonScratchOrgs: [] } }) } });
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const settings = { options: { compareCurrentType: true, showIdentical: false, excludedPackageIds: [], testLevel: 'auto', tests: [] }, source: { kind: 'project' as const, id: 'project:allowed' }, target: { kind: 'org' as const, identity: { alias: 'target', username: 'target@example.com', orgId: '00D1' } } };
      const repository = app.sfudRuntime.drafts;
      const earlier = await repository.reserveRevision(); const later = await repository.reserveRevision();
      const newer = await repository.save(owner.user.id, 'tab-one', { ...settings, options: { ...settings.options, showIdentical: true } }, later);
      await expect(repository.save(owner.user.id, 'tab-one', settings, earlier)).rejects.toThrow('최근 요청');
      expect((await repository.get(owner.user.id, newer.id)).settings.options.showIdentical).toBe(true);
      await expect(repository.get('other-owner', newer.id)).rejects.toThrow('만료');
      for (let index = 0; index < 19; index++) await repository.save(owner.user.id, `tab-${index}`, settings);
      await expect(repository.save(owner.user.id, 'over-limit', settings)).rejects.toThrow('20개');
      await app.sfudRuntime.store.database.run('UPDATE deployment_drafts SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00Z', newer.id);
      await expect(repository.get(owner.user.id, newer.id)).rejects.toThrow('만료');
      const replacement = await repository.save(owner.user.id, 'replacement-tab', settings);
      expect((await repository.list(owner.user.id))).toHaveLength(20);
      await repository.remove(owner.user.id, replacement.id);
      expect(await app.sfudRuntime.deploymentJobs.listRecentSummary(50, owner.user.id)).toEqual([]);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('lookup is authenticated, scoped to the original requester and never creates a job', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-submission-lookup-'));
    const app = await createWebServer({ host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'), assetsDirectory: '/missing', bootstrapToken: 'fixture', sfClient: { runJson: async () => ({ result: { nonScratchOrgs: [] } }) } });
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const other = await app.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id, email: 'other@example.com', displayName: 'other', role: 'OPERATOR', password: 'fixture-long-password' });
      const auth = await app.sfudRuntime.auth.login(other.email, 'fixture-long-password');
      const ownerHeaders = { cookie: `sfud_session=${owner.sessionToken}` }; const otherHeaders = { cookie: `sfud_session=${auth.sessionToken}` };
      const url = '/api/v1/deployment-submissions/dry-run/original-key';
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: ownerHeaders })).json()).toEqual({ state: 'UNCONFIRMED' });
      const created = await app.sfudRuntime.deploymentJobs.createIdempotentDryRun({ createdBy: owner.user.id, accessOwnerUserId: owner.user.id, clientRequestId: 'original-key', requestHash: 'b'.repeat(64), source: 'org:source', targetAlias: 'target', manifestPath: '@all', payloadChecksum: 'a'.repeat(64), targetOrgIdentity: { alias: 'target', username: 'original@example.com', orgId: '00D000000000001' } });
      const result = await app.inject({ url, headers: ownerHeaders });
      expect(result.json().state).toBe('FOUND'); expect(result.json().job.id).toBe(created.job.id);
      expect(result.json().job.target.username).toBe('original@example.com');
      expect((await app.inject({ url, headers: otherHeaders })).json()).toEqual({ state: 'UNCONFIRMED' });
      expect((await app.inject({ url: '/api/v1/deployment-submissions/direct/original-key', headers: ownerHeaders })).json()).toEqual({ state: 'UNCONFIRMED' });
      expect(await app.sfudRuntime.deploymentJobs.listRecentSummary(50, owner.user.id)).toHaveLength(1);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
