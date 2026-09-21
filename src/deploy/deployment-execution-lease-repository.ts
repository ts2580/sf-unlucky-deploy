import { randomUUID } from 'node:crypto';

import type { DatabaseExecutor } from '../storage/database-executor.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

export interface DeploymentExecutionLease {
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

/**
 * A durable, cross-process execution slot. Admission leases only protect
 * request preparation; this lease is held while Salesforce work is running.
 */
export class DeploymentExecutionLeaseRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly options: {
      maximumConcurrent?: number;
      leaseMs?: number;
      now?: () => number;
      createId?: () => string;
    } = {},
  ) {
    assertPositiveInteger(options.maximumConcurrent ?? 1, '배포 실행 동시성');
    assertPositiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, '배포 실행 lease 시간');
  }

  public async tryAcquire(jobId: string): Promise<DeploymentExecutionLease | undefined> {
    const id = (this.options.createId ?? randomUUID)();
    const now = this.now();
    const expiresAt = new Date(now + this.leaseMs()).toISOString();
    await this.database.transaction(async (transaction) => {
      await transaction.run('DELETE FROM deployment_execution_leases WHERE expires_at <= ?', new Date(now).toISOString());
      const occupied = await transaction.get<{ count: number }>('SELECT COUNT(*) count FROM deployment_execution_leases');
      if ((occupied?.count ?? 0) >= (this.options.maximumConcurrent ?? 1)) return;
      await transaction.run(
        'INSERT INTO deployment_execution_leases (id, job_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        id, jobId, expiresAt, new Date(now).toISOString(),
      );
    });
    const acquired = await this.database.get<{ id: string }>('SELECT id FROM deployment_execution_leases WHERE id = ?', id);
    if (acquired === undefined) return undefined;

    let released = false;
    return {
      renew: async () => {
        if (released) return false;
        const renewedAt = this.now();
        const result = await this.database.run(`
          UPDATE deployment_execution_leases SET expires_at = ?
          WHERE id = ? AND job_id = ? AND expires_at > ?
        `, new Date(renewedAt + this.leaseMs()).toISOString(), id, jobId, new Date(renewedAt).toISOString());
        return result.changes === 1;
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.database.run('DELETE FROM deployment_execution_leases WHERE id = ? AND job_id = ?', id, jobId);
      },
    };
  }

  public heartbeatIntervalMs(): number {
    return Math.max(1_000, Math.min(60_000, Math.floor(this.leaseMs() / 3)));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private leaseMs(): number { return this.options.leaseMs ?? DEFAULT_LEASE_MS; }
}

export function deploymentExecutionLeaseMsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const value = environment.SFUD_DEPLOYMENT_EXECUTION_LEASE_SECONDS;
  if (value === undefined) return DEFAULT_LEASE_MS;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3_600) {
    throw new Error('SFUD_DEPLOYMENT_EXECUTION_LEASE_SECONDS는 30초에서 3600초 사이의 정수여야 합니다.');
  }
  return seconds * 1_000;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}이 올바르지 않습니다.`);
}
