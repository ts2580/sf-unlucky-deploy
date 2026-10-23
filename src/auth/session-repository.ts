import type { DatabaseExecutor, DatabaseHandle } from '../storage/database-executor.js';
import type { UserRole } from './user-repository.js';

export interface SessionRow {
  session_id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  csrf_token_hash: string | null;
  expires_at: string;
  local_password_digest?: string | null;
}

/** Stores hashes only. The auth service owns expiry policy and local-mode credential binding. */
export class SessionRepository {
  public constructor(private readonly database: DatabaseExecutor) {}

  public async create(transaction: DatabaseHandle, input: {
    id: string; userId: string; tokenHash: string; csrfTokenHash: string; expiresAt: string; createdAt: string;
  }): Promise<void> {
    await transaction.run(`INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`, input.id, input.userId, input.tokenHash, input.csrfTokenHash, input.expiresAt, input.createdAt);
    await transaction.run('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL', input.createdAt);
  }

  public async find(tokenHash: string): Promise<SessionRow | undefined> {
    return this.database.get<SessionRow>(`
      SELECT s.id session_id, s.user_id, s.csrf_token_hash, s.expires_at,
             u.email, u.display_name, u.role, u.disabled_at, u.created_at, u.updated_at,
             pc.password_digest local_password_digest
      FROM sessions s JOIN users u ON u.id = s.user_id
      LEFT JOIN password_credentials pc ON pc.user_id = u.id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `, tokenHash);
  }

  public async revoke(tokenHash: string, timestamp: string): Promise<void> {
    await this.database.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', timestamp, tokenHash);
  }

  public async revokeUser(transaction: DatabaseHandle, userId: string, timestamp: string): Promise<void> {
    await transaction.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', timestamp, userId);
  }
}
