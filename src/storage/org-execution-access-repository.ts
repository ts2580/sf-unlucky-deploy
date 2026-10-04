import { SfudError } from '../core/errors.js';
import { normalizeSalesforceOrgId } from '../salesforce/org-identifier.js';
import type { DatabaseExecutor, DatabaseHandle } from './database-executor.js';

export interface OrgExecutionGrant {
  orgId: string;
  userId: string;
  grantedBy: string;
  createdAt: string;
}

/** 활성화된 target org에만 적용되는 실제 배포 allowlist. */
export class OrgExecutionAccessRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly localMode = false,
  ) {}

  public async grant(orgId: string, actorUserId: string, userId: string): Promise<void> {
    const normalizedOrgId = normalizeSalesforceOrgId(orgId);
    await this.database.transaction(async (transaction) => {
      await assertAdministrator(transaction, actorUserId);
      const user = await transaction.get('SELECT id FROM users WHERE id = ? AND disabled_at IS NULL', userId);
      if (user === undefined) throw new SfudError('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      const timestamp = this.now();
      await transaction.run(`
        INSERT INTO org_execution_policies_v2 (org_id, enabled_by, enabled_at) VALUES (?, ?, ?)
        ON CONFLICT(org_id) DO NOTHING
      `, normalizedOrgId, actorUserId, timestamp);
      await transaction.run(`
        INSERT INTO org_execution_grants_v2 (org_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(org_id, user_id) DO UPDATE SET granted_by = excluded.granted_by, created_at = excluded.created_at
      `, normalizedOrgId, userId, actorUserId, timestamp);
      await audit(transaction, actorUserId, normalizedOrgId, { userId, permission: 'EXECUTE' }, timestamp);
    });
  }

  public async revoke(orgId: string, actorUserId: string, userId: string): Promise<void> {
    const normalizedOrgId = normalizeSalesforceOrgId(orgId);
    await this.database.transaction(async (transaction) => {
      await assertAdministrator(transaction, actorUserId);
      await transaction.run('DELETE FROM org_execution_grants_v2 WHERE org_id = ? AND user_id = ?', normalizedOrgId, userId);
      await audit(transaction, actorUserId, normalizedOrgId, { userId, permission: 'REVOKED' }, this.now());
    });
  }

  public async list(): Promise<OrgExecutionGrant[]> {
    return (await this.database.all<Array<{
      org_id: string; user_id: string; granted_by: string; created_at: string;
    }>>(`SELECT org_id, user_id, granted_by, created_at FROM org_execution_grants_v2 ORDER BY org_id, user_id`))
      .map((row) => ({ orgId: row.org_id, userId: row.user_id, grantedBy: row.granted_by, createdAt: row.created_at }));
  }

  public async listPolicies(): Promise<Array<{ orgId: string; enabledAt: string; grantCount: number }>> {
    return (await this.database.all<Array<{ org_id: string; enabled_at: string; grant_count: number }>>(`
      SELECT p.org_id, p.enabled_at, COUNT(g.user_id) grant_count
      FROM org_execution_policies_v2 p LEFT JOIN org_execution_grants_v2 g ON g.org_id = p.org_id
      GROUP BY p.org_id ORDER BY p.org_id
    `)).map((row) => ({ orgId: row.org_id, enabledAt: row.enabled_at, grantCount: row.grant_count }));
  }

  public async listLegacyPolicies(): Promise<Array<{ targetAlias: string; grantCount: number }>> {
    return (await this.database.all<Array<{ target_alias: string; grant_count: number }>>(`
      SELECT p.target_alias, COUNT(g.user_id) grant_count
      FROM org_execution_policies p LEFT JOIN org_execution_grants g ON g.target_alias = p.target_alias
      GROUP BY p.target_alias ORDER BY p.target_alias
    `)).map((row) => ({ targetAlias: row.target_alias, grantCount: row.grant_count }));
  }

  public async assertCanExecute(orgId: string, userId: string): Promise<void> {
    const normalizedOrgId = normalizeSalesforceOrgId(orgId);
    const user = await this.database.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND disabled_at IS NULL', userId);
    if (user === undefined) throw new SfudError('APPROVAL_DENIED', '실제 배포 권한이 없습니다.');
    if (this.localMode) return;
    const policy = await this.database.get('SELECT org_id FROM org_execution_policies_v2 WHERE org_id = ?', normalizedOrgId);
    if (policy === undefined) throw new SfudError('APPROVAL_DENIED', '대상 Salesforce Org 실행 정책이 없습니다.');
    if (user.role === 'ADMIN') return;
    const grant = await this.database.get(`
      SELECT 1 allowed FROM org_execution_grants_v2 WHERE org_id = ? AND user_id = ?
    `, normalizedOrgId, userId);
    if (grant === undefined) throw new SfudError('APPROVAL_DENIED', '대상 Salesforce org의 실제 배포 권한이 없습니다.');
  }
}

async function assertAdministrator(database: DatabaseHandle, userId: string): Promise<void> {
  const user = await database.get<{ role: string }>('SELECT role FROM users WHERE id = ? AND disabled_at IS NULL', userId);
  if (user?.role !== 'ADMIN') throw new SfudError('APPROVAL_DENIED', '관리자 권한이 필요합니다.');
}

async function audit(
  database: DatabaseHandle,
  actorUserId: string,
  orgId: string,
  detail: Record<string, string>,
  timestamp: string,
): Promise<void> {
  await database.run(`
    INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
    VALUES (?, 'ORG_EXECUTION_ACCESS_CHANGED', 'SALESFORCE_ORG', ?, ?, ?)
  `, actorUserId, orgId, JSON.stringify(detail), timestamp);
}
