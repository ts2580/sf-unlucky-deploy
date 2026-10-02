import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';
import { DeploymentCoordinator } from '../src/deploy/deployment-coordinator.js';
import { DeploymentService } from '../src/deploy/deployment-service.js';
import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';
import type { WorkspaceService } from '../src/web/server/workspace-service.js';
import type { SfClient } from '../src/salesforce/sf-client.js';

const stores: SqliteStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const identity = { alias: 'fixture', username: 'fixture@example.com', orgId: '00D-fixture' };
const payload = { payloadChecksum: 'a'.repeat(64), digestVersion: 1, runDirectory: '/fixture/run' };

async function fixture() {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  stores.push(store);
  const jobs = new DeploymentJobRepository(store.database);
  const actor = await new UserRepository(store.database).create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
  const job = await jobs.createDirectDeployment({
    source: 'local:/fixture', targetAlias: identity.alias, targetOrgIdentity: identity,
    manifestPath: 'package.xml', payloadChecksum: payload.payloadChecksum, requestHash: payload.payloadChecksum,
    createdBy: actor.id, clientRequestId: 'direct-fixture', requestedTestLevel: 'RunLocalTests', requestedTests: [],
    targetConfirmation: identity.alias, confirmation: '실제 배포',
  });
  await jobs.transition(job.job.id, 'DEPLOYING');
  const begin = (operation: 'VALIDATE' | 'DEPLOY' = 'VALIDATE') => jobs.attempts.begin({ jobId: job.job.id, operation, ...payload });
  const progress = (id: string, phase: 'DRY_RUN' | 'DEPLOY' = 'DRY_RUN') => ({
    deploymentId: id, phase, status: 'Succeeded', done: true, success: true, checkedAt: new Date().toISOString(),
  });
  const reconcile = (report: unknown) => {
    const runJson = vi.fn<SfClient['runJson']>().mockResolvedValue(report);
    const workspace = {
      defaultProject: () => ({ realPath: process.cwd() }), getOrgIdentity: async () => identity,
    } as unknown as WorkspaceService;
    const service = new DeploymentService(jobs, new DeploymentCoordinator(jobs, new SingleJobQueue()), workspace, { runJson });
    return {
      run: () => service.reconcile(job.job.id, actor.id),
      bind: (input: {
        actorUserId?: string; deploymentId: string; operation: 'VALIDATE' | 'DEPLOY' | 'QUICK_DEPLOY';
        observedAt?: string; evidence: string;
      }) => service.bindUnknownAttemptAndReconcile({
        jobId: job.job.id, actorUserId: input.actorUserId ?? actor.id,
        deploymentId: input.deploymentId, operation: input.operation,
        observedAt: input.observedAt ?? new Date().toISOString(), evidence: input.evidence,
      }),
      runJson,
    };
  };
  return { store, jobs, actor, id: job.job.id, begin, progress, reconcile };
}

describe('단계별 제출 의도와 복구', () => {
  it('Quick Deploy 응답 유실 후 기존 검증 ID를 보존하며 실행 ID를 관리자 연결한다', async () => {
    const f = await fixture();
    const validationId = '0Af000000000001';
    const deploymentId = '0Af000000000002';
    const attemptId = await f.jobs.attempts.begin({
      jobId: f.id, operation: 'QUICK_DEPLOY', validationId, ...payload,
    });
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: {
      id: deploymentId, checkOnly: false, done: true, status: 'Succeeded', success: true,
      createdDate: new Date().toISOString(),
    } });
    await expect(remote.run()).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(remote.runJson).not.toHaveBeenCalled();
    expect(await remote.bind({ deploymentId, operation: 'QUICK_DEPLOY',
      evidence: 'Salesforce Deployment Status에서 Quick Deploy 실행 ID와 대상 org를 대조했습니다.',
    })).toMatchObject({ status: 'SUCCEEDED', salesforceDeploymentId: deploymentId });
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({
      validationId, deploymentId, submissionState: 'TERMINAL', operation: 'QUICK_DEPLOY',
    });
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ executionEvidence: 'MANUALLY_ATTESTED' });
    expect(remote.runJson.mock.calls.every(([args]) => args.slice(0, 3).join(' ') === 'project deploy report')).toBe(true);
    await expect(f.jobs.attempts.bindForReconciliation({
      jobId: f.id, attemptId, operation: 'QUICK_DEPLOY', deploymentId: '0Af000000000003',
      actorUserId: f.actor.id, observedAt: new Date().toISOString(), evidence: 'cannot rebind',
    })).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
  });

  it('제출 의도만 저장한 뒤 재시작하면 재확인으로 복구하며 새 제출을 막는다', async () => {
    const f = await fixture();
    const attemptId = await f.begin();
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({
      id: attemptId, operation: 'VALIDATE', submissionState: 'SUBMITTING',
      payloadChecksum: payload.payloadChecksum, digestVersion: 1,
      targetOrgIdentity: identity,
    });
    await f.jobs.recoverInterruptedJobs();
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ status: 'RECONCILE_REQUIRED' });
    await expect(f.begin()).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    const remote = f.reconcile({ result: { status: 'Succeeded', checkOnly: true } });
    await expect(remote.run()).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(remote.runJson).not.toHaveBeenCalled();
  });

  it('늦은 검증 callback이 실제 제출 ID와 진행 상태를 덮어쓰지 못한다', async () => {
    const f = await fixture();
    const validation = await f.begin();
    await f.jobs.recordSalesforceSubmission(f.id, 'validation-id', validation);
    await f.jobs.recordSalesforceProgress(f.id, f.progress('validation-id'), validation);
    const deploy = await f.begin('DEPLOY');
    expect((await f.jobs.getRequiredSummary(f.id)).salesforceDeploymentId).toBeUndefined();
    await f.jobs.recordSalesforceSubmission(f.id, 'actual-id', deploy);
    await expect(f.jobs.recordSalesforceSubmission(f.id, 'validation-id', validation)).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    await expect(f.jobs.recordSalesforceProgress(f.id, f.progress('validation-id'), validation)).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    await expect(f.jobs.recordSalesforceSubmission(f.id, 'unscoped-id')).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({ operation: 'DEPLOY', deploymentId: 'actual-id' });
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ salesforceDeploymentId: 'actual-id' });
    expect(await f.store.database.get('SELECT validation_id FROM deployment_attempts WHERE id = ?', validation))
      .toEqual({ validation_id: 'validation-id' });
  });

  it('검증 성공만 복구한 직접 배포는 실제 미배포 상태로 남긴다', async () => {
    const f = await fixture();
    const validation = await f.begin();
    await f.jobs.recordSalesforceSubmission(f.id, 'validation-id', validation);
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: { id: 'validation-id', status: 'Succeeded', done: true, success: true, checkOnly: true } });
    expect(await remote.run()).toMatchObject({ status: 'VALIDATED_PENDING_EXECUTION' });
    expect(remote.runJson).toHaveBeenCalledTimes(1);
    expect(remote.runJson.mock.calls[0]![0].slice(0, 3)).toEqual(['project', 'deploy', 'report']);
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({ submissionState: 'TERMINAL', operation: 'VALIDATE' });
  });

  it('검증만 복구된 직접 배포는 30분 뒤 재검증 필요 실패로 만료한다', async () => {
    const f = await fixture();
    const validation = await f.begin();
    await f.jobs.recordSalesforceSubmission(f.id, 'validation-id', validation);
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: { id: 'validation-id', status: 'Succeeded', done: true, success: true, checkOnly: true } });
    expect(await remote.run()).toMatchObject({ status: 'VALIDATED_PENDING_EXECUTION', completedAt: expect.any(String) });

    const expiredAt = new Date(Date.now() - 31 * 60 * 1_000).toISOString();
    await f.store.database.run('UPDATE deployment_jobs SET completed_at = ?, updated_at = ? WHERE id = ?', expiredAt, expiredAt, f.id);
    await expect(f.jobs.expireValidatedPendingExecutions()).resolves.toBe(1);
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({
      status: 'FAILED', errorCode: 'VALIDATION_EXECUTION_EXPIRED',
      errorMessage: expect.stringContaining('dry-run을 다시 실행'),
    });
  });

  it('실제 제출 의도 이후 중단하면 이전 검증 ID를 조회하지 않는다', async () => {
    const f = await fixture();
    const validation = await f.begin();
    await f.jobs.recordSalesforceProgress(f.id, f.progress('validation-id'), validation);
    await f.begin('DEPLOY');
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: { id: 'validation-id', status: 'Succeeded', checkOnly: true } });
    await expect(remote.run()).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(remote.runJson).not.toHaveBeenCalled();
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ status: 'RECONCILE_REQUIRED' });
  });

  it.each([
    { id: 'actual-id', checkOnly: true },
    { id: 'unrelated-id', checkOnly: false },
  ])('원격 유형 또는 실행 ID가 다른 성공 보고서를 거부한다: %j', async (result) => {
    const f = await fixture();
    const attempt = await f.begin('DEPLOY');
    await f.jobs.recordSalesforceSubmission(f.id, 'actual-id', attempt);
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: { ...result, done: true, status: 'Succeeded', success: true } });
    await expect(remote.run()).rejects.toMatchObject({ code: 'SF_EXTERNAL_STATE_UNKNOWN' });
    expect(await f.jobs.getRequiredSummary(f.id)).toMatchObject({ status: 'RECONCILE_REQUIRED' });
  });

  it('명확한 실제 실행 성공만 SUCCEEDED로 복구한다', async () => {
    const f = await fixture();
    const attempt = await f.begin('DEPLOY');
    await f.jobs.recordSalesforceSubmission(f.id, 'actual-id', attempt);
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: { id: 'actual-id', checkOnly: false, done: true, status: 'Succeeded', success: true } });
    expect(await remote.run()).toMatchObject({ status: 'SUCCEEDED' });
    expect(remote.runJson).toHaveBeenCalledTimes(1);
  });

  it('동시 제출 의도 중 하나만 저장한다', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.begin(), f.begin()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.store.database.get('SELECT COUNT(*) count FROM deployment_attempts WHERE job_id = ?', f.id))
      .toEqual({ count: 1 });
  });

  it('ADMIN은 ID 없는 제출을 원격 report·유형·근거와 대조한 뒤 감사 기록으로 연결한다', async () => {
    const f = await fixture();
    await f.begin();
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: {
      id: '0Af000000000001', checkOnly: true, done: true, status: 'Succeeded', success: true,
      createdDate: new Date().toISOString(),
    } });
    expect(await remote.bind({
      deploymentId: '0Af000000000001', operation: 'VALIDATE',
      evidence: 'Salesforce Deployment Status report의 대상 org와 제출 시각을 대조했습니다.',
    })).toMatchObject({ status: 'VALIDATED_PENDING_EXECUTION', salesforceDeploymentId: '0Af000000000001' });
    expect(remote.runJson).toHaveBeenCalledTimes(2);
    expect(await f.store.database.get<{ count: number }>(`
      SELECT COUNT(*) count FROM audit_events
      WHERE entity_id = ? AND event_type = 'DEPLOYMENT_ATTEMPT_MANUALLY_BOUND'
    `, f.id)).toEqual({ count: 1 });
    expect(await f.store.database.get<{ detail_json: string }>(`
      SELECT detail_json FROM audit_events
      WHERE entity_id = ? AND event_type = 'DEPLOYMENT_ATTEMPT_MANUALLY_BOUND'
    `, f.id)).toMatchObject({ detail_json: expect.stringContaining('대상 org와 제출 시각') });
  });

  it('ADMIN 연결은 유형·ID·근거 중 하나라도 맞지 않으면 attempt를 변경하지 않는다', async () => {
    const f = await fixture();
    const attempt = await f.begin();
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: {
      id: '0Af000000000001', checkOnly: true, done: true, status: 'Succeeded', success: true,
    } });
    await expect(remote.bind({
      deploymentId: '0Af000000000001', operation: 'DEPLOY',
      evidence: 'Salesforce Deployment Status report의 대상 org와 제출 시각을 대조했습니다.',
    })).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(remote.runJson).not.toHaveBeenCalled();
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({ id: attempt, submissionState: 'SUBMITTING' });
    await expect(remote.bind({
      deploymentId: '0Af000000000001', operation: 'VALIDATE', evidence: 'too short',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({ id: attempt, submissionState: 'SUBMITTING' });
  });

  it.each([
    { label: '과거 배포 시각', createdDate: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString() },
    { label: '누락된 배포 시각', createdDate: undefined },
  ])('관리자 연결에서 $label 보고서를 거부한다', async ({ createdDate }) => {
    const f = await fixture();
    const attemptId = await f.begin();
    await f.jobs.recoverInterruptedJobs();
    const remote = f.reconcile({ result: {
      id: '0Af000000000001', checkOnly: true, done: true, status: 'Succeeded', success: true,
      ...(createdDate === undefined ? {} : { createdDate }),
    } });
    await expect(remote.bind({ deploymentId: '0Af000000000001', operation: 'VALIDATE',
      evidence: '원격 배포 보고서와 제출 의도를 관리자 기록으로 대조했습니다.',
    })).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
    expect(await f.jobs.attempts.current(f.id)).toMatchObject({ id: attemptId, submissionState: 'SUBMITTING' });
  });

  it('이미 다른 작업의 attempt에 결합한 원격 ID를 수동 연결하지 않는다', async () => {
    const f = await fixture();
    const unknownAttempt = await f.begin();
    await f.jobs.recoverInterruptedJobs();
    const other = await f.jobs.createDirectDeployment({
      source: 'local:/fixture', targetAlias: identity.alias, targetOrgIdentity: identity,
      manifestPath: 'package.xml', payloadChecksum: payload.payloadChecksum, requestHash: 'b'.repeat(64),
      createdBy: f.actor.id, clientRequestId: 'other-direct-fixture', requestedTestLevel: 'RunLocalTests', requestedTests: [],
      targetConfirmation: identity.alias, confirmation: '실제 배포',
    });
    await f.jobs.transition(other.job.id, 'DEPLOYING');
    const otherAttempt = await f.jobs.attempts.begin({ jobId: other.job.id, operation: 'VALIDATE', ...payload });
    await f.jobs.recordSalesforceSubmission(other.job.id, '0Af000000000001', otherAttempt);
    await expect(f.jobs.attempts.bindForReconciliation({
      jobId: f.id, attemptId: unknownAttempt, operation: 'VALIDATE', deploymentId: '0Af000000000001',
      actorUserId: f.actor.id, observedAt: new Date().toISOString(), evidence: '관리자 수동 연결 시도',
    })).rejects.toMatchObject({ code: 'INVALID_JOB_STATE' });
  });

  it('ADMIN 외 사용자는 ID 없는 제출을 연결할 수 없다', async () => {
    const f = await fixture();
    await f.begin();
    await f.jobs.recoverInterruptedJobs();
    const deployer = await new UserRepository(f.store.database).create({
      email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER',
    });
    const remote = f.reconcile({ result: {
      id: '0Af000000000001', checkOnly: true, done: true, status: 'Succeeded', success: true,
    } });
    await expect(remote.bind({
      actorUserId: deployer.id, deploymentId: '0Af000000000001', operation: 'VALIDATE',
      evidence: 'Salesforce Deployment Status report의 대상 org와 제출 시각을 대조했습니다.',
    })).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(remote.runJson).not.toHaveBeenCalled();
  });
});
