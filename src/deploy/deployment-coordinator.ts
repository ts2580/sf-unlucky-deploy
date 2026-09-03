import { SfudError } from '../core/errors.js';
import {
  DeploymentJobRepository,
  type DeploymentJob,
  type RemoteDeploymentStatus,
} from './deployment-job-repository.js';
import { SingleJobQueue } from './single-job-queue.js';

export interface SalesforceJobResult {
  deploymentId?: string;
  remoteStatus?: RemoteDeploymentStatus;
  persistenceWarning?: string;
}

export class ReconciliationRequiredError extends Error {
  public readonly deploymentId: string | undefined;

  public constructor(message: string, deploymentId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReconciliationRequiredError';
    this.deploymentId = deploymentId;
  }
}

export class DeploymentCoordinator {
  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly queue: SingleJobQueue,
  ) {}

  public runDryRun(
    jobId: string,
    task: () => Promise<SalesforceJobResult>,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async () => {
      await this.jobs.transition(jobId, 'DRY_RUN_RUNNING');
      let result: SalesforceJobResult;
      try {
        result = await task();
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.jobs.transition(jobId, 'APPROVAL_PENDING', successDetails(result));
    });
  }

  public runDeployment(
    jobId: string,
    task: () => Promise<SalesforceJobResult>,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async () => {
      await this.jobs.transition(jobId, 'DEPLOYING');
      let result: SalesforceJobResult;
      try {
        result = await task();
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
      return await this.jobs.transition(jobId, 'SUCCEEDED', successDetails(result));
    });
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

function successDetails(result: SalesforceJobResult) {
  return {
    ...(result.deploymentId === undefined
      ? {}
      : { salesforceDeploymentId: result.deploymentId }),
    remoteStatus: result.remoteStatus ?? (result.deploymentId === undefined ? 'NOT_SUBMITTED' : 'SUCCEEDED'),
    ...(result.persistenceWarning === undefined ? {} : { persistenceWarning: result.persistenceWarning }),
  } satisfies Parameters<DeploymentJobRepository['transition']>[2];
}
