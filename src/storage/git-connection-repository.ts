import { randomUUID } from 'node:crypto';
import { GitError } from '../git/git-errors.js';
import { normalizeRepository, type GitProviderId } from '../git/git-repository.js';
import type { TokenContext, TokenVault } from '../git/token-vault.js';
import type { DatabaseExecutor, DatabaseHandle } from './database-executor.js';

export interface GitConnection {
  id: string;
  ownerUserId: string;
  provider: GitProviderId;
  providerHost: string;
  providerAccountId: string;
  displayName: string;
  repositoryPath?: string;
  expiresAt?: string;
  grantedPermissions: string[];
  status: 'ACTIVE' | 'REAUTH_REQUIRED' | 'REVOKED';
  createdAt: string;
  updatedAt: string;
}
export interface GitTokens { accessToken: string; apiUsername?: string; expiresAt?: string }
interface ConnectionRow {
  id: string; owner_user_id: string; provider: GitProviderId; provider_host: string;
  provider_account_id: string; display_name: string; encrypted_access_token: string | null;
  encrypted_refresh_token: string | null; encrypted_api_username: string | null; credential_type: string; expires_at: string | null; granted_permissions_json: string;
  repository_path: string | null;
  status: GitConnection['status']; key_version: number; token_version: number; created_at: string; updated_at: string;
}
type SaveConnection = Omit<GitConnection, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'expiresAt'> & { tokens: GitTokens };

export class GitConnectionRepository {
  public constructor(private readonly database: DatabaseExecutor, private readonly vault?: TokenVault) {}

  public assertReady(): void { this.requireVault(); }

  public async list(ownerUserId: string): Promise<GitConnection[]> {
    const rows = await this.database.all<ConnectionRow[]>(
      "SELECT * FROM git_connections WHERE owner_user_id = ? AND status <> 'REVOKED' ORDER BY created_at, id", ownerUserId,
    );
    return rows.map(publicConnection);
  }

  public async save(input: SaveConnection, expected?: { id: string; tokenVersion: number }): Promise<GitConnection> {
    const vault = this.requireVault();
    validateTokens(input.tokens);
    if (normalizeRepository('account/repository', input.provider).host !== input.providerHost
      || !safeValue(input.providerAccountId, 200) || !safeValue(input.displayName, 200)
      || (input.repositoryPath !== undefined && normalizeRepository(input.repositoryPath, input.provider).repositoryPath !== input.repositoryPath)
      || input.grantedPermissions.length > 100 || input.grantedPermissions.some((value) => !safeValue(value, 200))) {
      throw new GitError('GIT_REAUTH_REQUIRED');
    }
    const save = async (db: DatabaseHandle) => {
      const existing = await db.get<ConnectionRow>(`
        SELECT * FROM git_connections WHERE owner_user_id = ? AND provider = ? AND provider_host = ? AND provider_account_id = ?
      `, input.ownerUserId, input.provider, input.providerHost, input.providerAccountId);
      if (expected !== undefined && (existing?.id !== expected.id || existing.token_version !== expected.tokenVersion
        || existing.status === 'REVOKED')) throw new GitError('GIT_REAUTH_REQUIRED');
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      const connection: GitConnection = {
        id, ownerUserId: input.ownerUserId, provider: input.provider, providerHost: input.providerHost,
        providerAccountId: input.providerAccountId, displayName: input.displayName,
        grantedPermissions: input.grantedPermissions, status: 'ACTIVE',
        ...(input.repositoryPath === undefined ? {} : { repositoryPath: input.repositoryPath }),
        createdAt: existing?.created_at ?? now, updatedAt: now,
      };
      // Whitelist the public shape below; the input's raw tokens never leave this method.
      const access = vault.encrypt(input.tokens.accessToken, context(connection, 'access-token'));
      const apiUsername = input.tokens.apiUsername === undefined ? null
        : vault.encrypt(input.tokens.apiUsername, context(connection, 'api-username'));
      await db.run(`
        INSERT INTO git_connections (id, owner_user_id, provider, provider_host, provider_account_id,
          display_name, encrypted_access_token, encrypted_refresh_token, expires_at, granted_permissions_json,
          status, key_version, token_version, created_at, updated_at, credential_type, encrypted_api_username, repository_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ACTIVE', ?, 1, ?, ?, 'token', ?, ?)
        ON CONFLICT(owner_user_id, provider, provider_host, provider_account_id) DO UPDATE SET
          display_name = excluded.display_name, encrypted_access_token = excluded.encrypted_access_token,
          encrypted_refresh_token = NULL, expires_at = excluded.expires_at,
          credential_type = 'token', encrypted_api_username = excluded.encrypted_api_username,
          repository_path = excluded.repository_path,
          granted_permissions_json = excluded.granted_permissions_json, status = 'ACTIVE',
          key_version = excluded.key_version, token_version = git_connections.token_version + 1,
          updated_at = excluded.updated_at
      `, id, input.ownerUserId, input.provider, input.providerHost, input.providerAccountId, input.displayName,
      access, input.tokens.expiresAt ?? null, JSON.stringify(input.grantedPermissions),
      vault.currentKeyVersion, now, now, apiUsername, input.repositoryPath ?? null);
      await audit(db, input.ownerUserId, id, 'GIT_CONNECTION_SAVED', now);
      return publicConnection((await db.get<ConnectionRow>('SELECT * FROM git_connections WHERE id = ?', id))!);
    };
    return this.database.transaction(save);
  }

  public async replacementState(owner: string, id: string): Promise<{ connection: GitConnection; tokenVersion: number }> {
    this.requireVault();
    const row = await this.database.get<ConnectionRow>("SELECT * FROM git_connections WHERE id = ? AND owner_user_id = ? AND status <> 'REVOKED'", id, owner);
    if (row === undefined) throw new GitError('GIT_CONNECTION_REQUIRED');
    return { connection: publicConnection(row), tokenVersion: row.token_version };
  }

  public async readCredentials(ownerUserId: string, id: string): Promise<{ connection: GitConnection; tokens: GitTokens; tokenVersion: number }> {
    const vault = this.requireVault();
    const row = await this.database.get<ConnectionRow>('SELECT * FROM git_connections WHERE id = ? AND owner_user_id = ?', id, ownerUserId);
    if (row === undefined || row.status === 'REVOKED') throw new GitError('GIT_CONNECTION_REQUIRED');
    if (row.status !== 'ACTIVE' || row.credential_type !== 'token' || row.encrypted_access_token === null) throw new GitError('GIT_REAUTH_REQUIRED');
    const connection = publicConnection(row);
    return { connection, tokenVersion: row.token_version, tokens: {
      accessToken: vault.decrypt(row.encrypted_access_token, context(connection, 'access-token')),
      ...(row.encrypted_api_username === null ? {} : { apiUsername: vault.decrypt(row.encrypted_api_username, context(connection, 'api-username')) }),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    } };
  }

  public async requireReauthentication(ownerUserId: string, id: string, expectedVersion: number): Promise<void> {
    await this.clear(ownerUserId, id, 'REAUTH_REQUIRED', expectedVersion);
  }

  public async disconnect(ownerUserId: string, id: string): Promise<void> {
    await this.clear(ownerUserId, id, 'REVOKED');
  }

  private async clear(ownerUserId: string, id: string, status: 'REAUTH_REQUIRED' | 'REVOKED', expectedVersion?: number): Promise<void> {
    await this.database.transaction(async (db) => {
      const now = new Date().toISOString();
      const result = await db.run(`
        UPDATE git_connections SET encrypted_access_token = NULL, encrypted_refresh_token = NULL, encrypted_api_username = NULL,
          expires_at = NULL, status = ?, token_version = token_version + 1, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND status <> 'REVOKED'
          ${expectedVersion === undefined ? '' : 'AND token_version = ?'}
      `, status, now, id, ownerUserId, ...(expectedVersion === undefined ? [] : [expectedVersion]));
      if (result.changes !== 0) await audit(db, ownerUserId, id, `GIT_CONNECTION_${status}`, now);
      else if (expectedVersion === undefined) throw new GitError('GIT_CONNECTION_REQUIRED');
    });
  }

  private requireVault(): TokenVault {
    if (this.vault === undefined) throw new GitError('PROVIDER_NOT_CONFIGURED');
    return this.vault;
  }
}

function publicConnection(row: ConnectionRow): GitConnection {
  return { id: row.id, ownerUserId: row.owner_user_id, provider: row.provider, providerHost: row.provider_host,
    providerAccountId: row.provider_account_id, displayName: row.display_name, grantedPermissions: JSON.parse(row.granted_permissions_json) as string[],
    status: row.status === 'ACTIVE' && row.expires_at !== null && Date.parse(row.expires_at) <= Date.now() ? 'REAUTH_REQUIRED' : row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.repository_path == null ? {} : { repositoryPath: row.repository_path }) };
}
function context(connection: GitConnection, purpose: TokenContext['purpose']): TokenContext {
  return { ownerUserId: connection.ownerUserId, resourceId: connection.id, provider: connection.provider,
    host: connection.providerHost, purpose };
}
function validateTokens(tokens: GitTokens): void {
  if (!safeValue(tokens.accessToken, 16384) || (tokens.apiUsername !== undefined && !safeValue(tokens.apiUsername, 254))
    || (tokens.expiresAt !== undefined && (!Number.isFinite(Date.parse(tokens.expiresAt))
      || new Date(tokens.expiresAt).toISOString() !== tokens.expiresAt))) throw new GitError('GIT_REAUTH_REQUIRED');
}
function safeValue(value: string, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function audit(db: DatabaseHandle, owner: string, id: string, event: string, now: string): Promise<void> {
  await db.run(`INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
    VALUES (?, ?, 'GIT_CONNECTION', ?, '{}', ?)`, owner, event, id, now);
}
