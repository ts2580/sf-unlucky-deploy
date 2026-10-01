import { randomUUID } from 'node:crypto';

import { SfudError } from '../core/errors.js';
import type { TokenVault } from '../git/token-vault.js';
import { isOrgIdentifier, normalizeSalesforceOrgId } from '../salesforce/org-identifier.js';
import type { DatabaseExecutor } from './database-executor.js';

export interface SalesforceConnection {
  id: string;
  generation: number;
  alias: string;
  orgId: string;
  username: string;
  instanceUrl: string;
  status: 'CONNECTED' | 'REAUTH_REQUIRED';
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  owner_user_id: string;
  alias: string;
  org_id: string;
  username: string;
  instance_url: string;
  encrypted_auth_url: string;
  status: SalesforceConnection['status'];
  created_at: string;
  updated_at: string;
  generation: number;
}

export class SalesforceConnectionRepository {
  public constructor(private readonly database: DatabaseExecutor, private readonly vault?: TokenVault) {}

  public get ready(): boolean { return this.vault !== undefined; }

  public async list(ownerUserId: string): Promise<SalesforceConnection[]> {
    const rows = await this.database.all<ConnectionRow[]>(
      'SELECT * FROM salesforce_connections WHERE owner_user_id = ? ORDER BY alias', ownerUserId);
    return rows.map(toPublic);
  }

  public async get(ownerUserId: string, id: string): Promise<SalesforceConnection | undefined> {
    const row = await this.database.get<ConnectionRow>(
      'SELECT * FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId);
    return row === undefined ? undefined : toPublic(row);
  }

  public async getByAlias(ownerUserId: string, alias: string): Promise<SalesforceConnection | undefined> {
    const row = await this.database.get<ConnectionRow>(
      'SELECT * FROM salesforce_connections WHERE owner_user_id = ? AND alias = ?', ownerUserId, alias);
    return row === undefined ? undefined : toPublic(row);
  }

  public async authUrl(ownerUserId: string, id: string, expectedGeneration: number): Promise<string> {
    if (this.vault === undefined) throw new SfudError('STORAGE_ERROR', 'Salesforce 인증 암호화 키가 없습니다.');
    const row = await this.database.get<ConnectionRow>(
      'SELECT * FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId);
    if (row === undefined) throw new SfudError('APPROVAL_DENIED', 'Salesforce 연결을 찾을 수 없습니다.');
    if (row.generation !== expectedGeneration) throw new SfudError('ORG_IDENTITY_CHANGED', '실행 중 Salesforce 연결이 교체되었습니다. 작업을 다시 시작하세요.');
    try { return this.vault.decrypt(row.encrypted_auth_url, context(row.owner_user_id, row.id)); }
    catch { throw new SfudError('STORAGE_ERROR', 'Salesforce 인증 URL을 복호화하지 못했습니다. 암호화 키를 확인하세요.'); }
  }

  public async upsert(ownerUserId: string, alias: string, identity: {
    orgId: string; username: string; instanceUrl: string;
  }, authUrl: string, expected?: { id: string; generation: number }): Promise<SalesforceConnection> {
    if (this.vault === undefined) throw new SfudError('STORAGE_ERROR', 'Salesforce 인증 암호화 키가 없습니다.');
    if (!isOrgIdentifier(alias) || alias.length > 120) throw new SfudError('INVALID_ARGUMENT', 'Salesforce 연결 별칭이 올바르지 않습니다.');
    const normalizedOrgId = normalizeSalesforceOrgId(identity.orgId);
    const vault = this.vault;
    return this.database.transaction(async (db) => {
      const duplicate = await db.get<ConnectionRow>(
        'SELECT * FROM salesforce_connections WHERE owner_user_id = ? AND alias = ?', ownerUserId, alias);
      const existing = expected === undefined ? duplicate : await db.get<ConnectionRow>(
        'SELECT * FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', expected.id, ownerUserId);
      if (expected !== undefined && (existing === undefined || existing.generation !== expected.generation)) {
        throw new SfudError('ORG_IDENTITY_CHANGED', '실행 중 Salesforce 연결이 변경되었습니다. 다시 시작하세요.');
      }
      if (expected !== undefined && duplicate !== undefined && duplicate.id !== expected.id) {
        throw new SfudError('INVALID_ARGUMENT', '이미 사용 중인 Salesforce 별칭입니다.');
      }
      const id = existing?.id ?? randomUUID();
      const generation = (existing?.generation ?? 0) + 1;
      const encrypted = vault.encrypt(authUrl, context(ownerUserId, id));
      const now = new Date().toISOString();
      if (expected !== undefined) {
        await db.run(`UPDATE salesforce_connections SET alias = ?, org_id = ?, username = ?, instance_url = ?,
          encrypted_auth_url = ?, status = 'CONNECTED', updated_at = ?, generation = ? WHERE id = ? AND owner_user_id = ?`,
        alias, normalizedOrgId, identity.username, identity.instanceUrl, encrypted, now, generation, id, ownerUserId);
      } else {
        await db.run(`
          INSERT INTO salesforce_connections (id, owner_user_id, alias, org_id, username, instance_url,
            encrypted_auth_url, status, created_at, updated_at, generation)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'CONNECTED', ?, ?, ?)
          ON CONFLICT(owner_user_id, alias) DO UPDATE SET
            org_id = excluded.org_id, username = excluded.username, instance_url = excluded.instance_url,
            encrypted_auth_url = excluded.encrypted_auth_url, status = 'CONNECTED', updated_at = excluded.updated_at,
            generation = excluded.generation
        `, id, ownerUserId, alias, normalizedOrgId, identity.username, identity.instanceUrl, encrypted,
        existing?.created_at ?? now, now, generation);
      }
      return toPublic((await db.get<ConnectionRow>(
        'SELECT * FROM salesforce_connections WHERE owner_user_id = ? AND alias = ?', ownerUserId, alias))!);
    });
  }

  public async rotateAuthUrl(ownerUserId: string, id: string, expectedGeneration: number, authUrl: string): Promise<boolean> {
    if (this.vault === undefined) throw new SfudError('STORAGE_ERROR', 'Salesforce 인증 암호화 키가 없습니다.');
    const encrypted = this.vault.encrypt(authUrl, context(ownerUserId, id));
    const result = await this.database.run(`UPDATE salesforce_connections SET encrypted_auth_url = ?, status = 'CONNECTED',
      updated_at = ? WHERE id = ? AND owner_user_id = ? AND generation = ?`, encrypted,
    new Date().toISOString(), id, ownerUserId, expectedGeneration);
    return (result.changes ?? 0) === 1;
  }

  public async rename(ownerUserId: string, id: string, alias: string): Promise<SalesforceConnection | undefined> {
    if (!isOrgIdentifier(alias) || alias.length > 120) throw new SfudError('INVALID_ARGUMENT', 'Salesforce 연결 별칭이 올바르지 않습니다.');
    return this.database.transaction(async (db) => {
      const existing = await db.get<ConnectionRow>('SELECT * FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId);
      if (existing === undefined) return undefined;
      if (existing.alias === alias) return toPublic(existing);
      const duplicate = await db.get<{ id: string }>('SELECT id FROM salesforce_connections WHERE owner_user_id = ? AND alias = ?', ownerUserId, alias);
      if (duplicate !== undefined) throw new SfudError('INVALID_ARGUMENT', '이미 사용 중인 Salesforce 별칭입니다.');
      await db.run('UPDATE salesforce_connections SET alias = ?, generation = generation + 1, updated_at = ? WHERE id = ? AND owner_user_id = ?',
        alias, new Date().toISOString(), id, ownerUserId);
      return toPublic((await db.get<ConnectionRow>('SELECT * FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId))!);
    });
  }

  public async markReauthRequired(ownerUserId: string, id: string, expectedGeneration: number): Promise<boolean> {
    const result = await this.database.run(`UPDATE salesforce_connections SET status = 'REAUTH_REQUIRED', updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND generation = ?`, new Date().toISOString(), id, ownerUserId, expectedGeneration);
    return (result.changes ?? 0) === 1;
  }

  public async remove(ownerUserId: string, id: string): Promise<boolean> {
    const result = await this.database.run(
      'DELETE FROM salesforce_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId);
    return (result.changes ?? 0) > 0;
  }
}

function toPublic(row: ConnectionRow): SalesforceConnection {
  return { id: row.id, generation: row.generation, alias: row.alias, orgId: row.org_id, username: row.username,
    instanceUrl: row.instance_url, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function context(ownerUserId: string, resourceId: string) {
  return { ownerUserId, resourceId, provider: 'salesforce' as const,
    host: 'salesforce', purpose: 'sfdx-auth-url' as const };
}
