import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { DatabaseExecutor, DatabaseHandle } from '../storage/database-executor.js';
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

export interface CreateManagedUserInput {
  actorUserId: string;
  email: string;
  displayName: string;
  role: UserRole;
  password: string;
}

export interface UpdateManagedUserInput {
  actorUserId: string;
  userId: string;
  role?: UserRole;
  disabled?: boolean;
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
    private readonly database: DatabaseExecutor,
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

    await runInImmediateTransaction(this.database, async (transaction) => {
      const row = await transaction.get<{ count: number }>('SELECT COUNT(*) count FROM users');
      if ((row?.count ?? 0) !== 0) {
        throw new AuthError('BOOTSTRAP_DENIED', '최초 관리자 설정이 이미 완료되었습니다.');
      }
      await transaction.run(`
        INSERT INTO users (id, email, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, 'ADMIN', ?, ?)
      `, userId, email, displayName, timestamp, timestamp);
      await transaction.run(`
        INSERT INTO password_credentials (user_id, password_digest, updated_at)
        VALUES (?, ?, ?)
      `, userId, passwordDigest, timestamp);
      await this.writeAudit(transaction, userId, 'ADMIN_BOOTSTRAPPED', userId, { email }, timestamp);
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

  public async listUsers(): Promise<SfudUser[]> {
    const rows = await this.database.all<Array<{
      id: string;
      email: string;
      display_name: string;
      role: UserRole;
      disabled_at: string | null;
      created_at: string;
      updated_at: string;
    }>>(`
      SELECT id, email, display_name, role, disabled_at, created_at, updated_at
      FROM users
      ORDER BY disabled_at IS NOT NULL, display_name COLLATE NOCASE, email COLLATE NOCASE
    `);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public async createManagedUser(input: CreateManagedUserInput): Promise<SfudUser> {
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    assertUserRole(input.role);
    const passwordDigest = await hashPassword(input.password);
    const userId = this.createId();
    const timestamp = this.now().toISOString();
    await runInImmediateTransaction(this.database, async (transaction) => {
      const existing = await transaction.get<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
      if (existing !== undefined) {
        throw new UserAdministrationError('EMAIL_EXISTS', '이미 등록된 이메일입니다.');
      }
      await transaction.run(`
        INSERT INTO users (id, email, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, userId, email, displayName, input.role, timestamp, timestamp);
      await transaction.run(`
        INSERT INTO password_credentials (user_id, password_digest, updated_at)
        VALUES (?, ?, ?)
      `, userId, passwordDigest, timestamp);
      await this.writeUserAudit(transaction, input.actorUserId, 'USER_CREATED', userId, {
        email,
        displayName,
        role: input.role,
      }, timestamp);
    });
    return this.getUserRequired(userId);
  }

  public async updateManagedUser(input: UpdateManagedUserInput): Promise<SfudUser> {
    if (input.role !== undefined) assertUserRole(input.role);
    if (input.role === undefined && input.disabled === undefined) {
      throw new UserAdministrationError('NO_CHANGES', '변경할 사용자 설정이 없습니다.');
    }
    const timestamp = this.now().toISOString();
    await runInImmediateTransaction(this.database, async (transaction) => {
      const current = await transaction.get<{
        id: string;
        role: UserRole;
        disabled_at: string | null;
      }>('SELECT id, role, disabled_at FROM users WHERE id = ?', input.userId);
      if (current === undefined) {
        throw new UserAdministrationError('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      }
      const nextRole = input.role ?? current.role;
      const nextDisabled = input.disabled ?? (current.disabled_at !== null);
      if (input.actorUserId === input.userId && nextRole !== current.role) {
        throw new UserAdministrationError('SELF_ROLE_CHANGE_DENIED', '자기 자신의 역할은 변경할 수 없습니다.');
      }
      if (input.actorUserId === input.userId && nextDisabled) {
        throw new UserAdministrationError('SELF_DISABLE_DENIED', '자기 자신의 계정은 비활성화할 수 없습니다.');
      }
      if (
        current.role === 'ADMIN'
        && current.disabled_at === null
        && (nextRole !== 'ADMIN' || nextDisabled)
      ) {
        const others = await transaction.get<{ count: number }>(`
          SELECT COUNT(*) count FROM users
          WHERE id <> ? AND role = 'ADMIN' AND disabled_at IS NULL
        `, input.userId);
        if ((others?.count ?? 0) === 0) {
          throw new UserAdministrationError('LAST_ADMIN_REQUIRED', '마지막 활성 ADMIN은 변경할 수 없습니다.');
        }
      }
      const disabledAt = nextDisabled ? current.disabled_at ?? timestamp : null;
      await transaction.run(`
        UPDATE users SET role = ?, disabled_at = ?, updated_at = ? WHERE id = ?
      `, nextRole, disabledAt, timestamp, input.userId);
      if (nextDisabled && current.disabled_at === null) {
        await transaction.run(`
          UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
        `, timestamp, input.userId);
      }
      if (nextRole !== current.role) {
        await this.writeUserAudit(transaction, input.actorUserId, 'USER_ROLE_CHANGED', input.userId, {
          previousRole: current.role,
          role: nextRole,
        }, timestamp);
      }
      if (nextDisabled !== (current.disabled_at !== null)) {
        await this.writeUserAudit(
          transaction,
          input.actorUserId,
          nextDisabled ? 'USER_DISABLED' : 'USER_ENABLED',
          input.userId,
          {},
          timestamp,
        );
      }
    });
    return this.getUserRequired(input.userId);
  }

  private async createSession(userId: string): Promise<AuthenticatedSession> {
    const sessionToken = this.createSecret();
    const csrfToken = this.createSecret();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_LIFETIME_MS).toISOString();
    const sessionId = this.createId();
    await runInImmediateTransaction(this.database, async (transaction) => {
      await transaction.run(`
        INSERT INTO sessions (
          id, user_id, token_hash, csrf_token_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, sessionId, userId, hashSecret(sessionToken), hashSecret(csrfToken), expiresAt, createdAt.toISOString());
      await transaction.run(`
        DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL
      `, createdAt.toISOString());
      await this.writeAudit(transaction, userId, 'SESSION_CREATED', sessionId, {}, createdAt.toISOString());
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
    database: DatabaseHandle,
    actorUserId: string,
    eventType: string,
    entityId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    await database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, 'AUTH', ?, ?, ?)
    `, actorUserId, eventType, entityId, JSON.stringify(detail), timestamp);
  }

  private async writeUserAudit(
    database: DatabaseHandle,
    actorUserId: string,
    eventType: string,
    entityId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    await database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, 'USER', ?, ?, ?)
    `, actorUserId, eventType, entityId, JSON.stringify(detail), timestamp);
  }
}

export class AuthError extends Error {
  public constructor(public readonly code: 'BOOTSTRAP_DENIED' | 'INVALID_CREDENTIALS', message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class UserAdministrationError extends Error {
  public constructor(
    public readonly code:
      | 'EMAIL_EXISTS'
      | 'INVALID_ROLE'
      | 'LAST_ADMIN_REQUIRED'
      | 'NO_CHANGES'
      | 'SELF_DISABLE_DENIED'
      | 'SELF_ROLE_CHANGE_DENIED'
      | 'USER_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'UserAdministrationError';
  }
}

function hashSecret(value: string): string {
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

function assertUserRole(value: string): asserts value is UserRole {
  if (!['VIEWER', 'OPERATOR', 'DEPLOYER', 'ADMIN'].includes(value)) {
    throw new UserAdministrationError('INVALID_ROLE', '지원하지 않는 사용자 역할입니다.');
  }
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
