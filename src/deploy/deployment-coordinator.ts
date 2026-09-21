import { SfudError } from '../core/errors.js';
import {
  DeploymentJobRepository,
  type DeploymentJob,
} from './deployment-job-repository.js';
import { JobQueueCapacityError, type JobQueueReservation, SingleJobQueue } from './single-job-queue.js';
import { DeploymentCompletion, type SalesforceJobResult } from './deployment-completion.js';
import type { DeploymentExecutionLeaseRepository } from './deployment-execution-lease-repository.js';

export class ReconciliationRequiredError extends Error {
  public readonly deploymentId: string | undefined;

  public constructor(message: string, deploymentId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReconciliationRequiredError';
    this.deploymentId = deploymentId;
  }
}

export class DeploymentCoordinator {
  private readonly completion: DeploymentCompletion;

  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly queue: SingleJobQueue,
    private readonly executionLeases?: DeploymentExecutionLeaseRepository,
  ) {
    this.completion = new DeploymentCompletion(jobs);
  }

  public async flushCompletions(): Promise<void> {
    await this.completion.flush();
  }

  public runDryRun(
    jobId: string,
    task: (signal: AbortSignal) => Promise<SalesforceJobResult>,
    reservation?: JobQueueReservation,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async (signal) => await this.withExecutionLease(jobId, signal, async (executionSignal) => {
      await this.jobs.transition(jobId, 'DRY_RUN_RUNNING');
      let result: SalesforceJobResult;
      try {
        result = await task(executionSignal);
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.completion.complete(jobId, 'APPROVAL_PENDING', result);
    }), reservation);
  }

  public runDeployment(
    jobId: string,
    task: (signal: AbortSignal) => Promise<SalesforceJobResult>,
    reservation?: JobQueueReservation,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async (signal) => await this.withExecutionLease(jobId, signal, async (executionSignal) => {
      await this.jobs.transition(jobId, 'DEPLOYING');
      let result: SalesforceJobResult;
      try {
        result = await task(executionSignal);
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.completion.complete(jobId, 'SUCCEEDED', result);
    }), reservation);
  }

  public reserveQueueSlot(): JobQueueReservation {
    try {
      return this.queue.reserve();
    } catch (error) {
      if (error instanceof JobQueueCapacityError) {
        throw new SfudError('REQUEST_CAPACITY_EXCEEDED', '배포 대기 수가 서버 수용량에 도달했습니다. 잠시 후 다시 시도하세요.');
      }
      throw error;
    }
  }

  public assertAccepting(): void {
    this.queue.assertAccepting();
  }

  private async recordFailure(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ReconciliationRequiredError) {
      await this.jobs.transition(jobId, 'RECONCILE_REQUIRED', {
        errorCode: 'EXTERNAL_STATE_UNKNOWN',
        errorMessage: message,
        ...(error.deploymentId === undefined
          ? {}
          : { salesforceDeploymentId: error.deploymentId }),
        remoteStatus: 'UNKNOWN',
      });
      return;
    }
    await this.jobs.transition(jobId, 'FAILED', {
      errorCode: error instanceof SfudError && error.code === 'ORG_IDENTITY_CHANGED'
        ? error.code
        : 'JOB_EXECUTION_FAILED',
      errorMessage: message,
      ...(error instanceof SfudError && error.code === 'DEPLOY_FAILED'
        ? { remoteStatus: 'FAILED' as const }
        : {}),
    });
  }

  private async withExecutionLease<T>(
    jobId: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.executionLeases === undefined) return await operation(signal);
    const lease = await this.waitForExecutionLease(jobId, signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const interval = setInterval(() => {
      void lease.renew().then((renewed) => {
        if (!renewed) controller.abort(new Error('배포 실행 lease가 만료되었거나 다른 프로세스에 의해 회수되었습니다.'));
      }, (error: unknown) => controller.abort(error));
    }, this.executionLeases.heartbeatIntervalMs());
    interval.unref();
    try {
      if (signal.aborted) controller.abort(signal.reason);
      return await operation(controller.signal);
    } finally {
      clearInterval(interval);
      signal.removeEventListener('abort', onAbort);
      await lease.release();
    }
  }

  private async waitForExecutionLease(jobId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      const lease = await this.executionLeases!.tryAcquire(jobId);
      if (lease !== undefined) return lease;
      await waitForLease(signal);
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('배포 실행 대기 중 작업이 취소되었습니다.');
  }
}

function waitForLease(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('배포 실행 대기 중 작업이 취소되었습니다.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
