import { SfudError } from '../core/errors.js';
import type { DatabaseExecutor, DatabaseHandle } from './database-executor.js';

export interface OrgExecutionGrant {
  targetAlias: string;
  userId: string;
  grantedBy: string;
  createdAt: string;
}

/** 활성화된 target org에만 적용되는 실제 배포 allowlist. */
export class OrgExecutionAccessRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async grant(targetAlias: string, actorUserId: string, userId: string): Promise<void> {
    assertTargetAlias(targetAlias);
    await this.database.transaction(async (transaction) => {
      await assertAdministrator(transaction, actorUserId);
      const user = await transaction.get('SELECT id FROM users WHERE id = ? AND disabled_at IS NULL', userId);
      if (user === undefined) throw new SfudError('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      const timestamp = this.now();
      await transaction.run(`
        INSERT INTO org_execution_policies (target_alias, enabled_by, enabled_at) VALUES (?, ?, ?)
        ON CONFLICT(target_alias) DO NOTHING
      `, targetAlias, actorUserId, timestamp);
      await transaction.run(`
        INSERT INTO org_execution_grants (target_alias, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(target_alias, user_id) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at
      `, targetAlias, userId, actorUserId, timestamp);
      await audit(transaction, actorUserId, targetAlias, { userId, permission: 'EXECUTE' }, timestamp);
    });
  }

  public async revoke(targetAlias: string, actorUserId: string, userId: string): Promise<void> {
    assertTargetAlias(targetAlias);
    await this.database.transaction(async (transaction) => {
      await assertAdministrator(transaction, actorUserId);
      await transaction.run('DELETE FROM org_execution_grants WHERE target_alias = ? AND user_id = ?', targetAlias, userId);
      await audit(transaction, actorUserId, targetAlias, { userId, permission: 'REVOKED' }, this.now());
    });
  }

  public async list(): Promise<OrgExecutionGrant[]> {
    return (await this.database.all<Array<{
      target_alias: string; user_id: string; granted_by: string; created_at: string;
    }>>(`SELECT target_alias, user_id, granted_by, created_at FROM org_execution_grants ORDER BY target_alias, user_id`))
      .map((row) => ({ targetAlias: row.target_alias, userId: row.user_id, grantedBy: row.granted_by, createdAt: row.created_at }));
  }

  public async assertCanExecute(targetAlias: string, userId: string): Promise<void> {
    assertTargetAlias(targetAlias);
    const user = await this.database.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND disabled_at IS NULL', userId);
    if (user?.role === 'ADMIN') return;
    if (user === undefined) throw new SfudError('APPROVAL_DENIED', '실제 배포 권한이 없습니다.');
    const policy = await this.database.get('SELECT target_alias FROM org_execution_policies WHERE target_alias = ?', targetAlias);
    if (policy === undefined) return; // 기존 단일 운영자 설치는 명시 활성화 전까지 유지한다.
    const grant = await this.database.get(`
      SELECT 1 allowed FROM org_execution_grants WHERE target_alias = ? AND user_id = ?
    `, targetAlias, userId);
    if (grant === undefined) throw new SfudError('APPROVAL_DENIED', '대상 Salesforce org의 실제 배포 권한이 없습니다.');
  }
}

function assertTargetAlias(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new SfudError('INVALID_ARGUMENT', '대상 org 별칭 형식이 올바르지 않습니다.');
  }
}

async function assertAdministrator(database: DatabaseHandle, userId: string): Promise<void> {
  const user = await database.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND disabled_at IS NULL', userId);
  if (user?.role !== 'ADMIN') throw new SfudError('APPROVAL_DENIED', '관리자 권한이 필요합니다.');
}

async function audit(
  database: DatabaseHandle,
  actorUserId: string,
  targetAlias: string,
  detail: Record<string, string>,
  timestamp: string,
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
    VALUES (?, 'ORG_EXECUTION_ACCESS_CHANGED', 'SALESFORCE_ORG', ?, ?, ?)
  `, actorUserId, targetAlias, JSON.stringify(detail), timestamp);
}
