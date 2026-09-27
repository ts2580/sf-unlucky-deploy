import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';

const servers: Awaited<ReturnType<typeof createWebServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture() {
  const server = await createWebServer({
    host: '127.0.0.1', port: 0, assetsDirectory: '/missing', databasePath: ':memory:',
    bootstrapToken: 'git-access-bootstrap',
  });
  servers.push(server);
  const owner = await server.sfudRuntime.auth.bootstrapAdmin({
    bootstrapToken: 'git-access-bootstrap', email: 'owner@example.com',
    displayName: 'Owner', password: 'git access test password',
  });
  const otherUser = await server.sfudRuntime.auth.createManagedUser({
    actorUserId: owner.user.id, email: 'other@example.com', displayName: 'Other admin',
    role: 'ADMIN', password: 'git access test password',
  });
  const other = await server.sfudRuntime.auth.login(otherUser.email, 'git access test password');
  const headers = (session: typeof owner) => ({
    cookie: `sfud_session=${session.sessionToken}`, 'x-sfud-csrf': session.csrfToken,
  });
  const compare = (restricted = true) => server.sfudRuntime.comparisonJobs.create({
    projectPath: '/managed/private', manifestPath: '@all', scope: 'ALL',
    leftSource: 'org:target', rightSource: 'local:/managed/private',
    strict: false, showIdentical: false, createdBy: owner.user.id,
    ...(restricted ? { accessOwnerUserId: owner.user.id } : {}),
  });
  const dryRun = (restricted = true) => server.sfudRuntime.deploymentJobs.createDryRun({
    source: 'local:/managed/private', targetAlias: 'target', manifestPath: '@all', scope: 'ALL',
    payloadChecksum: 'a'.repeat(64), createdBy: owner.user.id,
    targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
    ...(restricted ? { accessOwnerUserId: owner.user.id } : {}),
  });
  return { server, owner, other, headers, compare, dryRun };
}

describe('개인 소스 파생 작업 접근', { timeout: 30_000 }, () => {
  it('다른 관리자에게 목록, 상세, components, artifacts, 실행, 재확인을 노출하지 않는다', async () => {
    const { server, owner, other, headers, compare, dryRun } = await fixture();
    const comparison = await compare();
    const deployment = await dryRun();
    for (const url of [
      `/api/v1/comparisons/${comparison.id}`, `/api/v1/comparisons/${comparison.id}/components`,
      `/api/v1/deployment-jobs/${deployment.id}`, `/api/v1/deployment-jobs/${deployment.id}/artifacts`,
    ]) {
      expect((await server.inject({ url, headers: headers(other) })).statusCode).toBe(404);
      expect((await server.inject({ url, headers: headers(owner) })).statusCode).toBe(200);
    }
    for (const url of ['/api/v1/comparisons', '/api/v1/deployment-jobs']) {
      expect((await server.inject({ url, headers: headers(other) })).json()).toEqual({ jobs: [] });
    }
    vi.spyOn(server.sfudRuntime.deploymentQueue, 'status').mockReturnValue({
      activeJobId: deployment.id, queuedCount: 0, accepting: true,
    });
    vi.spyOn(server.sfudRuntime.comparisonQueue, 'status').mockReturnValue({
      activeJobId: comparison.id, queuedCount: 0, accepting: true,
    });
    const diagnostics = await server.inject({ url: '/api/v1/diagnostics', headers: headers(other) });
    expect(diagnostics.body).not.toContain(deployment.id);
    expect(diagnostics.body).not.toContain(comparison.id);
    const approve = vi.spyOn(server.sfudRuntime.deployments, 'approveAndExecute');
    expect((await server.inject({
      method: 'POST', url: '/api/v1/deployments/execute', headers: headers(other),
      payload: { dryRunJobId: deployment.id, payloadChecksum: 'a'.repeat(64), targetAlias: 'target', confirmation: '실제 배포' },
    })).statusCode).toBe(404);
    expect(approve).not.toHaveBeenCalled();
    expect((await server.inject({
      method: 'POST', url: `/api/v1/deployment-jobs/${deployment.id}/reconcile`, headers: headers(other),
    })).statusCode).toBe(404);
    await expect(server.sfudRuntime.deploymentJobs.approveAndQueueDeployment({
      dryRunJobId: deployment.id, payloadChecksum: 'a'.repeat(64), targetAlias: 'target',
      confirmation: '실제 배포', approvedBy: other.user.id,
    })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(server.sfudRuntime.deployments.reconcile(deployment.id, other.user.id))
      .rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    // Authorization precedes loading even an invalid private result artifact.
    await server.sfudRuntime.store.database.run(
      'UPDATE comparison_jobs SET result_artifact_path = ? WHERE id = ?', '/missing/private.gz', comparison.id,
    );
    expect((await server.inject({ url: `/api/v1/comparisons/${comparison.id}`, headers: headers(other) })).statusCode).toBe(404);
  });

  it('명시적 읽기/실행 공유, 역할 조건, 철회와 소유자만 공유 변경을 적용한다', async () => {
    const { server, owner, other, headers, dryRun } = await fixture();
    const job = await dryRun();
    const url = `/api/v1/job-access/deployment/${job.id}/${other.user.id}`;
    expect((await server.inject({ method: 'PUT', url, headers: headers(other), payload: { permission: 'EXECUTE' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PUT', url, headers: { cookie: headers(owner).cookie }, payload: { permission: 'READ' } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'PUT', url, headers: headers(owner), payload: { permission: 'READ' } })).statusCode).toBe(204);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', job.id, other.user.id)).toBe(true);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', job.id, other.user.id, 'EXECUTE')).toBe(false);
    expect((await server.inject({ method: 'PUT', url, headers: headers(owner), payload: { permission: 'EXECUTE' } })).statusCode).toBe(204);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', job.id, other.user.id, 'EXECUTE')).toBe(true);
    await server.sfudRuntime.store.database.run("UPDATE users SET role = 'VIEWER' WHERE id = ?", other.user.id);
    expect((await server.inject({
      method: 'POST', url: '/api/v1/deployments/execute', headers: headers(other),
      payload: { dryRunJobId: job.id, payloadChecksum: 'a'.repeat(64), targetAlias: 'target', confirmation: '실제 배포' },
    })).statusCode).toBe(403);
    await expect(server.sfudRuntime.deployments.reconcile(job.id, other.user.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect((await server.inject({ method: 'DELETE', url, headers: headers(owner) })).statusCode).toBe(204);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', job.id, other.user.id)).toBe(false);
    expect(await server.sfudRuntime.store.database.get(
      "SELECT COUNT(*) count FROM audit_events WHERE event_type = 'JOB_ACCESS_CHANGED' AND entity_id = ?", job.id,
    )).toEqual({ count: 3 });
    await expect(server.sfudRuntime.store.database.run('DELETE FROM users WHERE id = ?', owner.user.id)).rejects.toThrow();
  });

  it('기존 공유 작업을 보존하고 접근 필터를 목록 개수 제한보다 먼저 적용한다', async () => {
    const { server, owner, other, headers, compare, dryRun } = await fixture();
    const legacyComparison = await compare(false);
    const legacyDeployment = await dryRun(false);
    for (let index = 0; index < 55; index += 1) { await compare(); await dryRun(); }
    expect((await server.inject({ url: '/api/v1/comparisons', headers: headers(other) })).json().jobs)
      .toEqual([expect.objectContaining({ id: legacyComparison.id })]);
    expect((await server.inject({ url: '/api/v1/deployment-jobs', headers: headers(other) })).json().jobs)
      .toEqual([expect.objectContaining({ id: legacyDeployment.id })]);
    expect((await server.inject({ url: '/api/v1/comparisons', headers: headers(owner) })).json().jobs).toHaveLength(30);
  });

  it('공유받은 배포 담당자가 승인해도 원래 소유권과 공유 범위를 배포에 상속한다', async () => {
    const { server, owner, other, dryRun } = await fixture();
    const job = await dryRun();
    const { deploymentJobs: jobs, jobAccess } = server.sfudRuntime;
    await jobAccess.grant('deployment', job.id, owner.user.id, other.user.id, 'EXECUTE');
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-access-artifacts-'));
    try {
      await jobs.transition(job.id, 'DRY_RUN_RUNNING');
      await jobs.recordDryRunArtifacts({
        id: job.id, payloadChecksum: 'a'.repeat(64), runDirectory,
        comparisonResult: {
          generatedAt: new Date().toISOString(), strict: false,
          left: { displayName: 'target', kind: 'org', manifestSha256: 'a'.repeat(64), payloadSha256: 'a'.repeat(64) },
          right: { displayName: 'source', kind: 'local', manifestSha256: 'a'.repeat(64), payloadSha256: 'a'.repeat(64) },
          summary: { added: 0, removed: 0, modified: 0, identical: 0, total: 0, different: 0 },
          components: [], warnings: [],
        },
        testPlan: { level: 'RunLocalTests', tests: [], selection: 'fallback' },
        dryRunResult: { status: 0, result: { id: '0Af-dry-run' } },
      });
      await jobs.transition(job.id, 'APPROVAL_PENDING');
      const deployment = await jobs.approveAndQueueDeployment({
        dryRunJobId: job.id, approvedBy: other.user.id, payloadChecksum: 'a'.repeat(64),
        targetAlias: 'target', confirmation: '실제 배포',
      });
      expect(await server.sfudRuntime.store.database.get(
        'SELECT access_owner_user_id owner FROM deployment_jobs WHERE id = ?', deployment.id,
      )).toEqual({ owner: owner.user.id });
      expect(await jobAccess.canAccess('deployment', deployment.id, owner.user.id, 'EXECUTE')).toBe(true);
      expect(await jobAccess.canAccess('deployment', deployment.id, other.user.id, 'EXECUTE')).toBe(true);
      const stranger = await server.sfudRuntime.users.create({ email: 'stranger@example.com', displayName: 'Stranger', role: 'ADMIN' });
      expect(await jobAccess.canAccess('deployment', deployment.id, stranger.id)).toBe(false);
      await jobAccess.revoke('deployment', deployment.id, owner.user.id, other.user.id);
      expect(await jobAccess.canAccess('deployment', deployment.id, other.user.id)).toBe(false);
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  });

  it('SSE에서 비공개 작업을 숨기고 공유 철회 및 로그아웃을 열린 스트림에 반영한다', async () => {
    const { server, owner, other, headers, compare } = await fixture();
    const privateJob = await compare();
    const publicJob = await compare(false);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const abort = new AbortController();
    const response = await fetch(`${address}/api/v1/workflow/events`, { headers: headers(other), signal: abort.signal });
    const reader = response.body!.getReader();
    let stream = '';
    const until = async (marker: string) => {
      while (!stream.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE ended before marker');
        stream += new TextDecoder().decode(chunk.value);
      }
    };
    const publish = (id: string, status: string) => server.sfudRuntime.workflowEvents.publish({
      resource: 'comparison', jobId: id, kind: 'COMPARE', status, updatedAt: new Date().toISOString(),
    });
    try {
      publish(privateJob.id, 'PRIVATE_HIDDEN');
      publish(publicJob.id, 'PUBLIC_MARKER');
      await until('PUBLIC_MARKER');
      expect(stream).not.toContain(privateJob.id);
      await server.sfudRuntime.jobAccess.grant('comparison', privateJob.id, owner.user.id, other.user.id, 'READ');
      publish(privateJob.id, 'SHARED_VISIBLE');
      await until('SHARED_VISIBLE');
      await server.sfudRuntime.jobAccess.revoke('comparison', privateJob.id, owner.user.id, other.user.id);
      publish(privateJob.id, 'REVOKED_HIDDEN');
      publish(publicJob.id, 'AFTER_REVOKE');
      await until('AFTER_REVOKE');
      expect(stream).not.toContain('REVOKED_HIDDEN');
      await server.sfudRuntime.auth.revoke(other.sessionToken);
      publish(publicJob.id, 'AFTER_LOGOUT');
      const last = await reader.read();
      expect(last.done).toBe(true);
      expect(server.sfudRuntime.workflowEvents.subscriberCount()).toBe(0);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});
