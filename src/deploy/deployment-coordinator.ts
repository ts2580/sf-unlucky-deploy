import { SfudError } from '../core/errors.js';
import {
  DeploymentJobRepository,
  type DeploymentJob,
} from './deployment-job-repository.js';
import { SingleJobQueue } from './single-job-queue.js';
import { DeploymentCompletion, type SalesforceJobResult } from './deployment-completion.js';

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
  ) {
    this.completion = new DeploymentCompletion(jobs);
  }

  public async flushCompletions(): Promise<void> {
    await this.completion.flush();
  }

  public runDryRun(
    jobId: string,
    task: (signal: AbortSignal) => Promise<SalesforceJobResult>,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async (signal) => {
      await this.jobs.transition(jobId, 'DRY_RUN_RUNNING');
      let result: SalesforceJobResult;
      try {
        result = await task(signal);
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.completion.complete(jobId, 'APPROVAL_PENDING', result);
    });
  }

  public runDeployment(
    jobId: string,
    task: (signal: AbortSignal) => Promise<SalesforceJobResult>,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async (signal) => {
      await this.jobs.transition(jobId, 'DEPLOYING');
      let result: SalesforceJobResult;
      try {
        result = await task(signal);
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.completion.complete(jobId, 'SUCCEEDED', result);
    });
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
}
