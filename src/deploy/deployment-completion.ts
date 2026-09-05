import { redactSensitiveText } from '../salesforce/sf-client.js';
import type { DeploymentJob, DeploymentJobRepository, RemoteDeploymentStatus, TransitionDetails } from './deployment-job-repository.js';

export interface SalesforceJobResult {
  deploymentId?: string;
  remoteStatus?: RemoteDeploymentStatus;
  persistenceWarning?: string;
}

interface PendingCompletion {
  status: 'APPROVAL_PENDING' | 'SUCCEEDED';
  details: TransitionDetails;
}

/** Salesforce 재제출 없이 완료 상태의 저장만 재시도한다. */
export class DeploymentCompletion {
  private readonly pending = new Map<string, PendingCompletion>();
  private retryTimer: NodeJS.Timeout | undefined;
  private retryRequest: Promise<void> | undefined;

  public constructor(
    private readonly jobs: Pick<DeploymentJobRepository, 'transition' | 'getRequiredSummary'>,
  ) {}

  public async complete(
    id: string,
    status: PendingCompletion['status'],
    result: SalesforceJobResult,
  ): Promise<DeploymentJob> {
    const completion: PendingCompletion = { status, details: {
      completedAt: new Date().toISOString(),
      ...(result.deploymentId === undefined ? {} : { salesforceDeploymentId: result.deploymentId }),
      remoteStatus: result.remoteStatus ?? (result.deploymentId === undefined ? 'NOT_SUBMITTED' : 'SUCCEEDED'),
      ...(result.persistenceWarning === undefined ? {} : { persistenceWarning: result.persistenceWarning }),
    } };
    try {
      return await this.jobs.transition(id, status, completion.details);
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      completion.details.persistenceWarning = [result.persistenceWarning, `완료 상태 저장 실패: ${message}`]
        .filter(Boolean).join(' ');
      this.pending.set(id, completion);
      try {
        // UPDATE가 커밋된 뒤 알림이나 후속 조회만 실패했을 수 있다.
        const current = await this.jobs.getRequiredSummary(id);
        if (current.status === status) {
          this.pending.delete(id);
          return current;
        }
        if (current.status === 'RECONCILE_REQUIRED') return current;
        return await this.jobs.transition(id, 'RECONCILE_REQUIRED', {
          ...completion.details,
          errorCode: 'COMPLETION_PERSISTENCE_FAILED',
          errorMessage: 'Salesforce 결과는 확인했지만 완료 상태를 저장하지 못했습니다. 상태 저장을 재시도합니다.',
        });
      } finally {
        this.scheduleRetry();
      }
    }
  }

  public async flush(): Promise<void> {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.retryPending();
    if (this.pending.size > 0) {
      throw new Error('배포 완료 상태를 저장하지 못했습니다. 결과 복구를 위해 저장소를 닫지 않습니다.');
    }
  }

  private retryPending(): Promise<void> {
    if (this.retryRequest !== undefined) return this.retryRequest;
    this.retryRequest = (async () => {
      for (const [id, completion] of this.pending) {
        try {
          const current = await this.jobs.getRequiredSummary(id);
          if (['APPROVAL_PENDING', 'SUCCEEDED', 'FAILED'].includes(current.status)) {
            this.pending.delete(id);
            continue;
          }
          await this.jobs.transition(id, completion.status, completion.details);
          this.pending.delete(id);
        } catch {
          // DB 전체 장애 중에도 확인된 원격 결과를 메모리에 보존한다.
        }
      }
    })().finally(() => {
      this.retryRequest = undefined;
      this.scheduleRetry();
    });
    return this.retryRequest;
  }

  private scheduleRetry(): void {
    if (this.pending.size === 0 || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPending();
    }, 1_000);
    this.retryTimer.unref();
  }
}
