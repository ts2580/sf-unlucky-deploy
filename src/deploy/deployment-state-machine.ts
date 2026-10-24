import { SfudError } from '../core/errors.js';
import type { DeploymentJob, DeploymentJobStatus } from './deployment-job-model.js';

const allowedTransitions: Record<DeploymentJobStatus, ReadonlySet<DeploymentJobStatus>> = {
  QUEUED: new Set(['DRY_RUN_RUNNING', 'DEPLOYING', 'FAILED']),
  DRY_RUN_RUNNING: new Set(['APPROVAL_PENDING', 'FAILED', 'RECONCILE_REQUIRED']),
  APPROVAL_PENDING: new Set(),
  VALIDATED_PENDING_EXECUTION: new Set(['FAILED']),
  DEPLOYING: new Set(['SUCCEEDED', 'FAILED', 'RECONCILE_REQUIRED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  RECONCILE_REQUIRED: new Set(['APPROVAL_PENDING', 'VALIDATED_PENDING_EXECUTION', 'SUCCEEDED', 'FAILED']),
};

/** Pure state decisions; the repository commits them with its optimistic state guard. */
export class DeploymentStateMachine {
  public transition(
    job: Pick<DeploymentJob, 'kind' | 'status' | 'startedAt'>,
    nextStatus: DeploymentJobStatus,
    timestamp: string,
    completedAt?: string,
  ): { status: DeploymentJobStatus; startedAt: string | null; completedAt: string | null } {
    if (!allowedTransitions[job.status].has(nextStatus)) {
      throw new SfudError('INVALID_JOB_STATE', `허용되지 않은 배포 상태 전이입니다: ${job.status} → ${nextStatus}`);
    }
    if (job.kind === 'DRY_RUN' && nextStatus === 'DEPLOYING') {
      throw new SfudError('INVALID_JOB_STATE', 'dry-run 작업은 DEPLOYING 상태로 전이할 수 없습니다.');
    }
    if (job.kind === 'DEPLOY' && nextStatus === 'DRY_RUN_RUNNING') {
      throw new SfudError('INVALID_JOB_STATE', '실제 배포 작업은 DRY_RUN_RUNNING 상태로 전이할 수 없습니다.');
    }
    return {
      status: nextStatus,
      startedAt: nextStatus === 'DRY_RUN_RUNNING' || nextStatus === 'DEPLOYING'
        ? timestamp : job.startedAt ?? null,
      completedAt: ['APPROVAL_PENDING', 'VALIDATED_PENDING_EXECUTION', 'SUCCEEDED', 'FAILED'].includes(nextStatus)
        ? completedAt ?? timestamp : null,
    };
  }
}
