import { SfudError } from '../core/errors.js';
import type { DatabaseExecutor, DatabaseHandle } from './database-executor.js';

export type JobType = 'comparison' | 'deployment';
export type JobPermission = 'READ' | 'EXECUTE';

// Only these constants become SQL identifiers; request data always uses bindings.
function tableFor(type: JobType): string {
  if (type === 'comparison') return 'comparison_jobs';
  if (type === 'deployment') return 'deployment_jobs';
  throw new Error('지원하지 않는 작업 종류입니다.');
}

export function jobVisibilitySql(type: JobType): string {
  const table = tableFor(type);
  return `(${table}.access_owner_user_id IS NULL OR ${table}.access_owner_user_id = ? OR EXISTS (
    SELECT 1 FROM job_access_grants g WHERE g.job_type = '${type}'
    AND g.job_id = ${table}.id AND g.user_id = ?
  ))`;
}

export async function assertJobAccess(
  database: DatabaseHandle, type: JobType, id: string, userId: string, permission: JobPermission,
): Promise<void> {
  if (!await canAccessJob(database, type, id, userId, permission)) {
    throw new SfudError('JOB_NOT_FOUND', '작업을 찾을 수 없습니다.');
  }
}

async function canAccessJob(
  database: DatabaseHandle, type: JobType, id: string, userId: string, permission: JobPermission,
): Promise<boolean> {
  const table = tableFor(type);
  const row = await database.get<{ allowed: number }>(`
    SELECT 1 AS allowed FROM ${table} j
    WHERE j.id = ? AND (
      j.access_owner_user_id IS NULL OR j.access_owner_user_id = ? OR EXISTS (
        SELECT 1 FROM job_access_grants g WHERE g.job_type = ? AND g.job_id = j.id
        AND g.user_id = ? AND (? = 'READ' OR g.permission = 'EXECUTE')
      )
    ) AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL)
  `, id, userId, type, userId, permission, userId);
  return row !== undefined;
}

export async function initializeJobAccess(
  database: DatabaseHandle, type: JobType, id: string, ownerUserId: string | undefined,
): Promise<void> {
  if (ownerUserId === undefined) return;
  await database.run(`UPDATE ${tableFor(type)} SET access_owner_user_id = ? WHERE id = ?`, ownerUserId, id);
}

export class JobAccessRepository {
  public constructor(private readonly database: DatabaseExecutor) {}

  public async canAccess(type: JobType, id: string, userId: string, permission: JobPermission = 'READ'): Promise<boolean> {
    return canAccessJob(this.database, type, id, userId, permission);
  }

  public async grant(type: JobType, id: string, ownerId: string, userId: string, permission: JobPermission): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.assertOwner(transaction, type, id, ownerId);
      const user = await transaction.get('SELECT id FROM users WHERE id = ? AND disabled_at IS NULL', userId);
      if (user === undefined) throw new SfudError('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      const timestamp = new Date().toISOString();
      await transaction.run(`
        INSERT INTO job_access_grants (job_type, job_id, user_id, permission, granted_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_type, job_id, user_id) DO UPDATE SET
          permission = excluded.permission, granted_by = excluded.granted_by, created_at = excluded.created_at
      `, type, id, userId, permission, ownerId, timestamp);
      await this.audit(transaction, type, id, ownerId, userId, permission, timestamp);
    });
  }

  public async revoke(type: JobType, id: string, ownerId: string, userId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.assertOwner(transaction, type, id, ownerId);
      await transaction.run('DELETE FROM job_access_grants WHERE job_type = ? AND job_id = ? AND user_id = ?', type, id, userId);
      await this.audit(transaction, type, id, ownerId, userId, 'REVOKED', new Date().toISOString());
    });
  }

  private async assertOwner(database: DatabaseHandle, type: JobType, id: string, ownerId: string): Promise<void> {
    const row = await database.get(`
      SELECT id FROM ${tableFor(type)} WHERE id = ? AND access_owner_user_id = ?
      AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL)
    `, id, ownerId, ownerId);
    if (row === undefined) throw new SfudError('JOB_NOT_FOUND', '작업을 찾을 수 없습니다.');
  }

  private async audit(database: DatabaseHandle, type: JobType, id: string, actor: string,
    userId: string, permission: string, timestamp: string): Promise<void> {
    await database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, 'JOB_ACCESS_CHANGED', ?, ?, ?, ?)
    `, actor, type === 'comparison' ? 'COMPARISON_JOB' : 'DEPLOYMENT_JOB', id,
    JSON.stringify({ userId, permission }), timestamp);
  }
}
