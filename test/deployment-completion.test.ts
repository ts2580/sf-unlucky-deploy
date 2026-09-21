import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeploymentCompletion } from '../src/deploy/deployment-completion.js';
import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  const jobs = new DeploymentJobRepository(store.database);
  const job = await jobs.createDryRun({
    source: 'local:/fixture', targetAlias: 'target', manifestPath: '@all', payloadChecksum: 'a'.repeat(64),
    targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
  });
  await jobs.transition(job.id, 'DRY_RUN_RUNNING');
  return { store, jobs, id: job.id, completion: new DeploymentCompletion(jobs) };
}

describe('배포 완료 저장 복구', () => {
  it('재확인에서 검증만 완료된 상태로 해소되면 오래된 성공 저장 재시도를 폐기한다', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      await f.store.database.run("UPDATE deployment_jobs SET kind = 'DEPLOY', status = 'DEPLOYING' WHERE id = ?", f.id);
      const transition = f.jobs.transition.bind(f.jobs);
      vi.spyOn(f.jobs, 'transition').mockImplementationOnce(async () => { throw new Error('database locked'); });
      expect(await f.completion.complete(f.id, 'SUCCEEDED', { deploymentId: 'validation-id' }))
        .toMatchObject({ status: 'RECONCILE_REQUIRED' });
      await transition(f.id, 'VALIDATED_PENDING_EXECUTION');
      await f.completion.flush();
      expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ status: 'VALIDATED_PENDING_EXECUTION' });
    } finally { vi.restoreAllMocks(); await f.completion.flush(); await f.store.close(); }
  });

  it('attempt 버전이 바뀌면 오래된 완료 저장 재시도를 폐기한다', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const attemptId = await f.jobs.attempts.begin({
        jobId: f.id, operation: 'VALIDATE', payloadChecksum: 'a'.repeat(64), digestVersion: 1,
        runDirectory: '/fixture/run',
      });
      const attempt = await f.jobs.attempts.current(f.id);
      vi.spyOn(f.jobs, 'transition').mockImplementationOnce(async () => { throw new Error('database locked'); });
      expect(await f.completion.complete(f.id, 'APPROVAL_PENDING', {
        deploymentId: '0Af000000000001', attemptId, attemptVersion: attempt!.version,
      })).toMatchObject({ status: 'RECONCILE_REQUIRED' });
      await f.store.database.run('UPDATE deployment_attempts SET version = version + 1 WHERE id = ?', attemptId);
      await f.completion.flush();
      expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ status: 'RECONCILE_REQUIRED' });
      expect(f.jobs.transition).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); await f.completion.flush(); await f.store.close(); }
  });

  it('최종 저장 실패를 재확인 상태로 보존하고 자동으로 DB 저장만 재시도한다', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const transition = f.jobs.transition.bind(f.jobs);
      let fail = true;
      vi.spyOn(f.jobs, 'transition').mockImplementation(async (id, status, details) => {
        if (status === 'APPROVAL_PENDING' && fail) { fail = false; throw new Error('database locked'); }
        return transition(id, status, details);
      });
      expect(await f.completion.complete(f.id, 'APPROVAL_PENDING', { deploymentId: '0Af000000000001' }))
        .toMatchObject({ status: 'RECONCILE_REQUIRED', remoteStatus: 'SUCCEEDED', salesforceDeploymentId: '0Af000000000001' });
      await vi.advanceTimersByTimeAsync(1_000);
      await f.completion.flush();
      expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({
        status: 'APPROVAL_PENDING', remoteStatus: 'SUCCEEDED', prepared: false,
        persistenceWarning: expect.stringContaining('완료 상태 저장 실패'),
      });
    } finally { await f.completion.flush(); await f.store.close(); }
  });

  it('DB 전체 장애 중 결과를 유지하고 저장 복구 전 종료를 거부한다', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const write = vi.spyOn(f.jobs, 'transition').mockRejectedValue(new Error('database offline'));
      const read = vi.spyOn(f.jobs, 'getRequiredSummary').mockRejectedValue(new Error('database offline'));
      const completedAt = new Date().toISOString();
      await expect(f.completion.complete(f.id, 'APPROVAL_PENDING', { deploymentId: '0Af000000000001' })).rejects.toThrow('offline');
      await expect(f.completion.flush()).rejects.toThrow('저장소를 닫지 않습니다');
      vi.setSystemTime(Date.now() + 3_600_000);
      write.mockRestore(); read.mockRestore();
      await f.completion.flush();
      expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({
        status: 'APPROVAL_PENDING', salesforceDeploymentId: '0Af000000000001', completedAt,
      });
    } finally { vi.restoreAllMocks(); await f.completion.flush(); await f.store.close(); }
  });

  it('커밋 뒤 알림만 실패한 완료 상태를 재확인 상태로 되돌리지 않는다', async () => {
    const f = await fixture();
    try {
      const transition = f.jobs.transition.bind(f.jobs);
      vi.spyOn(f.jobs, 'transition').mockImplementationOnce(async (...args) => {
        await transition(...args);
        throw new Error('notification failed');
      });
      expect(await f.completion.complete(f.id, 'APPROVAL_PENDING', { deploymentId: '0Af000000000001' }))
        .toMatchObject({ status: 'APPROVAL_PENDING' });
      await f.completion.flush();
      expect(f.jobs.transition).toHaveBeenCalledTimes(1);
    } finally { await f.completion.flush(); await f.store.close(); }
  });
});
