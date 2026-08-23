import {
  DeploymentJobRepository,
  type DeploymentJob,
} from './deployment-job-repository.js';
import { SingleJobQueue } from './single-job-queue.js';

export interface SalesforceJobResult {
  deploymentId?: string;
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
      try {
        const result = await task();
        return await this.jobs.transition(jobId, 'APPROVAL_PENDING', {
          ...(result.deploymentId === undefined
            ? {}
            : { salesforceDeploymentId: result.deploymentId }),
        });
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
    });
  }

  public runDeployment(
    jobId: string,
    task: () => Promise<SalesforceJobResult>,
  ): Promise<DeploymentJob> {
    return this.queue.enqueue(jobId, async () => {
      await this.jobs.transition(jobId, 'DEPLOYING');
      try {
        const result = await task();
        return await this.jobs.transition(jobId, 'SUCCEEDED', {
          ...(result.deploymentId === undefined
            ? {}
            : { salesforceDeploymentId: result.deploymentId }),
        });
      } catch (error) {
        await this.recordFailure(jobId, error);
        throw error;
      }
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
      });
      return;
    }
    await this.jobs.transition(jobId, 'FAILED', {
      errorCode: 'JOB_EXECUTION_FAILED',
      errorMessage: message,
    });
  }
}
