import { randomUUID } from 'node:crypto';

import { SfudError } from '../core/errors.js';
import type { DatabaseExecutor } from '../storage/database-executor.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

export interface DeploymentAdmissionLease {
  release(): Promise<void>;
}

/** SQLite transaction으로 여러 웹 프로세스가 함께 사용하는 준비 단계 lease. */
export class DeploymentAdmissionRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly options: {
      maximumPerUser?: number;
      maximumTotal?: number;
      leaseMs?: number;
      now?: () => number;
      createId?: () => string;
    } = {},
  ) {
    assertPositiveInteger(options.maximumPerUser ?? 2, '사용자별 접수 준비 한도');
    assertPositiveInteger(options.maximumTotal ?? 8, '전체 접수 준비 한도');
    assertPositiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, '접수 준비 lease 시간');
  }

  public async reserve(userId: string): Promise<DeploymentAdmissionLease> {
    const id = (this.options.createId ?? randomUUID)();
    const now = new Date((this.options.now ?? Date.now)());
    const expiresAt = new Date(now.getTime() + (this.options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
    const timestamp = now.toISOString();
    await this.database.transaction(async (transaction) => {
      await transaction.run('DELETE FROM deployment_admission_leases WHERE expires_at <= ?', timestamp);
      const byUser = await transaction.get<{ count: number }>(
        'SELECT COUNT(*) count FROM deployment_admission_leases WHERE user_id = ?', userId,
      );
      if ((byUser?.count ?? 0) >= (this.options.maximumPerUser ?? 2)) {
        throw new SfudError('REQUEST_USER_LIMIT', '동시에 준비할 수 있는 배포 요청 수를 초과했습니다. 잠시 후 다시 시도하세요.');
      }
      const total = await transaction.get<{ count: number }>('SELECT COUNT(*) count FROM deployment_admission_leases');
      if ((total?.count ?? 0) >= (this.options.maximumTotal ?? 8)) {
        throw new SfudError('REQUEST_CAPACITY_EXCEEDED', '서버의 배포 요청 준비 수용량을 초과했습니다. 잠시 후 다시 시도하세요.');
      }
      await transaction.run(
        'INSERT INTO deployment_admission_leases (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        id, userId, expiresAt, timestamp,
      );
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.database.run('DELETE FROM deployment_admission_leases WHERE id = ?', id);
      },
    };
  }
}

export function deploymentAdmissionLeaseMsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const value = environment.SFUD_DEPLOYMENT_ADMISSION_LEASE_SECONDS;
  if (value === undefined) return DEFAULT_LEASE_MS;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3_600) {
    throw new Error('SFUD_DEPLOYMENT_ADMISSION_LEASE_SECONDS는 30초에서 3600초 사이의 정수여야 합니다.');
  }
  return seconds * 1_000;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}이 올바르지 않습니다.`);
}
