import { describe, expect, it } from 'vitest';
import { DeploymentStateMachine } from '../src/deploy/deployment-state-machine.js';
import type { DeploymentJobKind, DeploymentJobStatus } from '../src/deploy/deployment-job-model.js';

const machine = new DeploymentStateMachine();
const startedAt = '2026-10-22T01:00:00.000Z';
const finishedAt = '2026-10-22T01:01:00.000Z';

describe('DeploymentStateMachine', () => {
  it.each([
    ['DRY_RUN', 'DRY_RUN_RUNNING', 'APPROVAL_PENDING'],
    ['DEPLOY', 'DEPLOYING', 'SUCCEEDED'],
  ] as const)('%s의 실행과 완료 전이를 계산하고 입력을 변경하지 않는다', (kind, running, finished) => {
    const queued = Object.freeze({ kind, status: 'QUEUED' as const });
    const execution = machine.transition(queued, running, startedAt);
    expect(execution).toEqual({ status: running, startedAt, completedAt: null });
    expect(machine.transition({ kind, ...execution, startedAt }, finished, finishedAt)).toEqual({
      status: finished, startedAt, completedAt: finishedAt,
    });
    expect(queued.status).toBe('QUEUED');
  });

  it.each([
    ['DRY_RUN', 'DEPLOYING'], ['DEPLOY', 'DRY_RUN_RUNNING'],
  ] as const)('%s가 다른 종류의 실행 상태 %s로 들어가는 것을 거부한다', (kind, next) => {
    expect(() => machine.transition({ kind, status: 'QUEUED' }, next, startedAt))
      .toThrow(expect.objectContaining({ code: 'INVALID_JOB_STATE' }));
  });

  it.each(['SUCCEEDED', 'FAILED', 'APPROVAL_PENDING'] as const)('완료 상태 %s를 다시 실행하지 않는다', (status) => {
    expect(() => machine.transition({ kind: 'DEPLOY', status, startedAt }, 'DEPLOYING', finishedAt))
      .toThrow(expect.objectContaining({ code: 'INVALID_JOB_STATE' }));
  });

  it('실행 전 실패에는 시작 시각을 만들지 않는다', () => {
    expect(machine.transition({ kind: 'DEPLOY', status: 'QUEUED' }, 'FAILED', finishedAt)).toEqual({
      status: 'FAILED', startedAt: null, completedAt: finishedAt,
    });
  });

  it.each([
    ['DRY_RUN', 'APPROVAL_PENDING'], ['DEPLOY', 'SUCCEEDED'], ['DEPLOY', 'VALIDATED_PENDING_EXECUTION'],
  ] satisfies Array<[DeploymentJobKind, DeploymentJobStatus]>)('재확인한 %s를 %s로 복구하며 원래 시각을 보존한다', (kind, next) => {
    const unknown = machine.transition({ kind, status: kind === 'DRY_RUN' ? 'DRY_RUN_RUNNING' : 'DEPLOYING', startedAt },
      'RECONCILE_REQUIRED', finishedAt);
    expect(unknown).toEqual({ status: 'RECONCILE_REQUIRED', startedAt, completedAt: null });
    expect(machine.transition({ kind, status: unknown.status, startedAt }, next,
      '2026-10-22T01:05:00.000Z', finishedAt)).toEqual({ status: next, startedAt, completedAt: finishedAt });
  });

  it('검증만 복구된 과거 작업의 만료 실패 전이를 유지한다', () => {
    expect(machine.transition({ kind: 'DEPLOY', status: 'VALIDATED_PENDING_EXECUTION', startedAt },
      'FAILED', finishedAt)).toMatchObject({ status: 'FAILED', startedAt, completedAt: finishedAt });
  });
});
