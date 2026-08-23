import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Database } from 'sqlite';

import { runInImmediateTransaction } from '../storage/transaction.js';
import type { SfudUser, UserRole } from '../storage/user-repository.js';
import { hashPassword, verifyPassword } from './password.js';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const FAKE_PASSWORD_DIGEST = 'scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$3kLAKUwMy10P1x8fQiqWLxWgFa9tsv8KlTl9KlfPvqrYXZJtdQlkUdILMGQeKsgQHUl_VJusZ4QGtE8zpdlzLA';

export interface AuthenticatedSession {
  user: SfudUser;
  csrfToken: string;
  expiresAt: string;
  sessionToken: string;
}

interface SessionRow {
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
}

export class AuthService {
  private bootstrapToken: string | undefined;

  public constructor(
    private readonly database: Database,
    bootstrapToken: string | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly createSecret: () => string = () => randomBytes(32).toString('base64url'),
  ) {
    this.bootstrapToken = bootstrapToken;
  }

  public async isSetupRequired(): Promise<boolean> {
    const row = await this.database.get<{ count: number }>('SELECT COUNT(*) count FROM users');
    return row?.count === 0;
  }

  public getBootstrapToken(): string | undefined {
    return this.bootstrapToken;
  }

  public async bootstrapAdmin(input: {
    bootstrapToken: string;
    email: string;
    displayName: string;
    password: string;
  }): Promise<AuthenticatedSession> {
    if (this.bootstrapToken === undefined || !safeSecretEquals(input.bootstrapToken, this.bootstrapToken)) {
      throw new AuthError('BOOTSTRAP_DENIED', '초기 설정 코드가 올바르지 않습니다.');
    }
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    const passwordDigest = await hashPassword(input.password);
    const userId = this.createId();
    const timestamp = this.now().toISOString();

    await runInImmediateTransaction(this.database, async () => {
      const row = await this.database.get<{ count: number }>('SELECT COUNT(*) count FROM users');
      if ((row?.count ?? 0) !== 0) {
        throw new AuthError('BOOTSTRAP_DENIED', '최초 관리자 설정이 이미 완료되었습니다.');
      }
      await this.database.run(`
        INSERT INTO users (id, email, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, 'ADMIN', ?, ?)
      `, userId, email, displayName, timestamp, timestamp);
      await this.database.run(`
        INSERT INTO password_credentials (user_id, password_digest, updated_at)
        VALUES (?, ?, ?)
      `, userId, passwordDigest, timestamp);
      await this.writeAudit(userId, 'ADMIN_BOOTSTRAPPED', userId, { email }, timestamp);
    });
    this.bootstrapToken = undefined;
    return this.createSession(userId);
  }

  public async login(emailInput: string, password: string): Promise<AuthenticatedSession> {
    const email = normalizeEmail(emailInput);
    const row = await this.database.get<{ user_id: string; password_digest: string; disabled_at: string | null }>(`
      SELECT u.id user_id, pc.password_digest, u.disabled_at
      FROM users u
      JOIN password_credentials pc ON pc.user_id = u.id
      WHERE u.email = ?
    `, email);
    const valid = await verifyPassword(password, row?.password_digest ?? FAKE_PASSWORD_DIGEST);
    if (!valid || row === undefined || row.disabled_at !== null) {
      throw new AuthError('INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    return this.createSession(row.user_id);
  }

  public async authenticate(sessionToken: string | undefined): Promise<SfudUser | undefined> {
    if (sessionToken === undefined || sessionToken.length === 0) return undefined;
    const row = await this.getSessionRow(sessionToken);
    if (row === undefined || row.disabled_at !== null || row.expires_at <= this.now().toISOString()) {
      return undefined;
    }
    return mapUser(row);
  }

  public async sessionState(sessionToken: string | undefined): Promise<{
    user: SfudUser;
    csrfTokenHash: string;
    expiresAt: string;
  } | undefined> {
    if (sessionToken === undefined || sessionToken.length === 0) return undefined;
    const row = await this.getSessionRow(sessionToken);
    if (
      row === undefined
      || row.disabled_at !== null
      || row.expires_at <= this.now().toISOString()
      || row.csrf_token_hash === null
    ) return undefined;
    return { user: mapUser(row), csrfTokenHash: row.csrf_token_hash, expiresAt: row.expires_at };
  }

  public async revoke(sessionToken: string): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.database.run(`
      UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `, timestamp, hashSecret(sessionToken));
  }

  public verifyCsrf(csrfToken: string | undefined, expectedHash: string): boolean {
    return csrfToken !== undefined && safeSecretEquals(hashSecret(csrfToken), expectedHash);
  }

  private async createSession(userId: string): Promise<AuthenticatedSession> {
    const sessionToken = this.createSecret();
    const csrfToken = this.createSecret();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS).toISOString();
    const sessionId = this.createId();
    await runInImmediateTransaction(this.database, async () => {
      await this.database.run(`
        INSERT INTO sessions (
          id, user_id, token_hash, csrf_token_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, sessionId, userId, hashSecret(sessionToken), hashSecret(csrfToken), expiresAt, createdAt.toISOString());
      await this.database.run(`
        DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL
      `, createdAt.toISOString());
      await this.writeAudit(userId, 'SESSION_CREATED', sessionId, {}, createdAt.toISOString());
    });
    const user = await this.getUserRequired(userId);
    return { user, csrfToken, expiresAt, sessionToken };
  }

  private async getSessionRow(sessionToken: string): Promise<SessionRow | undefined> {
    return this.database.get<SessionRow>(`
      SELECT s.id session_id, s.user_id, s.csrf_token_hash, s.expires_at,
             u.email, u.display_name, u.role, u.disabled_at, u.created_at, u.updated_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `, hashSecret(sessionToken));
  }

  private async getUserRequired(userId: string): Promise<SfudUser> {
    const row = await this.database.get<SessionRow>(`
      SELECT id session_id, id user_id, email, display_name, role, disabled_at,
             created_at, updated_at, '' csrf_token_hash, '' expires_at
      FROM users WHERE id = ?
    `, userId);
    if (row === undefined) throw new Error(`사용자를 찾을 수 없습니다: ${userId}`);
    return mapUser(row);
  }

  private async writeAudit(
    actorUserId: string,
    eventType: string,
    entityId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    await this.database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, 'AUTH', ?, ?, ?)
    `, actorUserId, eventType, entityId, JSON.stringify(detail), timestamp);
  }
}

export class AuthError extends Error {
  public constructor(public readonly code: 'BOOTSTRAP_DENIED' | 'INVALID_CREDENTIALS', message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeSecretEquals(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error('유효한 이메일이 필요합니다.');
  }
  return email;
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    throw new Error('표시 이름은 1자 이상 80자 이하여야 합니다.');
  }
  return displayName;
}

function mapUser(row: SessionRow): SfudUser {
  return {
    id: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
