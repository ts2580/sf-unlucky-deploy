import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { resolveJobSelection } from '../src/web/server/deployment-selection-resolver.js';

describe('new selection from a deployment job', () => {
  it('restores only configuration, scopes access and revalidates Org identities without submitting deployments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-job-selection-'));
    const sourceIdentity = { alias: 'source', username: 'source@example.com', orgId: '00D000000000001' };
    const targetIdentity = { alias: 'target', username: 'target@example.com', orgId: '00D000000000002' };
    let currentSource = { ...sourceIdentity };
    let currentTarget = { ...targetIdentity };
    const runJson = vi.fn(async (args: readonly string[]) => {
      if (args.includes('deploy')) throw new Error('Selection restoration must never submit a deployment');
      return { result: { nonScratchOrgs: [currentSource, currentTarget].map((org) => ({ ...org, connectedStatus: 'Connected' })) } };
    });
    const app = await createWebServer({ host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'), assetsDirectory: '/missing', bootstrapToken: 'fixture', sfClient: { runJson } });
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const other = await app.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id, email: 'other@example.com', displayName: 'other', role: 'OPERATOR', password: 'fixture-long-password' });
      const otherSession = await app.sfudRuntime.auth.login(other.email, 'fixture-long-password');
      const headers = { cookie: `sfud_session=${owner.sessionToken}`, 'x-sfud-csrf': owner.csrfToken };
      const otherHeaders = { cookie: `sfud_session=${otherSession.sessionToken}`, 'x-sfud-csrf': otherSession.csrfToken };
      const { job } = await app.sfudRuntime.deploymentJobs.createIdempotentDryRun({
        createdBy: owner.user.id, accessOwnerUserId: owner.user.id, clientRequestId: 'selection-origin', requestHash: 'b'.repeat(64),
        source: 'org:source', sourceOrgIdentity: sourceIdentity, targetAlias: 'target', targetOrgIdentity: targetIdentity,
        manifestPath: '@all', metadataType: 'ApexClass', payloadChecksum: 'a'.repeat(64),
        selectedComponents: [{ type: 'ApexClass', fullName: 'OriginalComponent' }],
      });
      // Seed a completed validation's persisted configuration without invoking Salesforce.
      await app.sfudRuntime.store.database.run('UPDATE deployment_jobs SET status = ?, is_prepared = 1, test_plan_json = ? WHERE id = ?',
        'APPROVAL_PENDING', JSON.stringify({ level: 'RunSpecifiedTests', tests: ['Original_Test'], selection: 'explicit' }), job.id);
      const original = await app.sfudRuntime.deploymentJobs.getRequiredSummary(job.id);
      const expected = { sourceId: 'org:source', targetId: 'org:target', metadataType: 'ApexClass', compareCurrentType: true, showIdentical: false, excludedPackageIds: [], testLevel: 'RunSpecifiedTests', tests: ['Original_Test'] };
      const restored = await resolveJobSelection(app.sfudRuntime, owner.user.id, job.id);
      expect(restored.selection).toMatchObject(expected);
      expect(Object.keys(restored.selection!).sort()).toEqual([...Object.keys(expected), 'expectedSourceIdentityFingerprint', 'expectedTargetIdentityFingerprint'].sort());
      expect(restored.preparationRequired).toBe(false);
      const base = `/api/v1/deployment-jobs/${job.id}`;
      expect((await app.inject({ url: `${base}/new-selection` })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `${base}/prepare-new-selection`, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
      for (const prepare of [false, true]) {
        const method = prepare ? 'POST' : 'GET';
        const url = `${base}/${prepare ? 'prepare-new-selection' : 'new-selection'}`;
        const response = await app.inject({ method, url, headers });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual(restored);
        expect((await app.inject({ method, url, headers: otherHeaders })).statusCode).toBe(409);
        currentTarget = { ...targetIdentity, orgId: '00D000000000003' };
        expect((await app.inject({ method, url, headers })).statusCode).toBe(409);
        currentTarget = { ...targetIdentity };
        currentSource = { ...sourceIdentity, orgId: '00D000000000004' };
        expect((await app.inject({ method, url, headers })).statusCode).toBe(409);
        currentSource = { ...sourceIdentity };
      }
      expect(await app.sfudRuntime.deploymentJobs.listRecentSummary(50, owner.user.id)).toHaveLength(1);
      expect(await app.sfudRuntime.deploymentJobs.getRequiredSummary(job.id)).toEqual(original);
      expect(runJson.mock.calls.some(([args]) => args.includes('deploy'))).toBe(false);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
