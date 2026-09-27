import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AuthError } from '../../auth/auth-service.js';
import { MAX_PASSWORD_LENGTH } from '../../auth/password.js';
import type { SfudUser } from '../../storage/user-repository.js';
import type { UserRole } from '../../storage/user-repository.js';
import type {
  ApiErrorResponse,
  AuthSessionResponse,
  AuthStatusResponse,
} from '../shared/api.js';

const SESSION_COOKIE = 'sfud_session';
const CSRF_COOKIE = 'sfud_csrf';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const configuredPublicOrigins = new WeakMap<FastifyInstance, string>();

interface BootstrapBody {
  bootstrapToken?: string;
  email?: string;
  displayName?: string;
  password?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

export interface AuthRouteSecurityOptions {
  publicOrigin?: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteSecurityOptions = {},
): Promise<void> {
  if (options.publicOrigin !== undefined) configuredPublicOrigins.set(app, options.publicOrigin);
  const ipLimiter = new FailedAttemptLimiter(5, 15 * 60 * 1_000);
  const accountLimiter = new FailedAttemptLimiter(5, 30 * 60 * 1_000);
  const bootstrapLimiter = new FailedAttemptLimiter(5, 30 * 60 * 1_000);
  const passwordSlots = new PasswordExecutionLimiter(5);

  app.get('/api/v1/auth/status', async (request): Promise<AuthStatusResponse> => {
    const user = await app.sfudRuntime.auth.authenticate(readCookie(request, SESSION_COOKIE));
    return {
      setupRequired: await app.sfudRuntime.auth.isSetupRequired(),
      authenticated: user !== undefined,
      ...(user === undefined ? {} : { user: toApiUser(user) }),
    };
  });

  app.post<{ Body: BootstrapBody }>('/api/v1/auth/bootstrap', async (request, reply) => {
    if (!hasAllowedOrigin(request, options.publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
    }
    const attempt = bootstrapLimiter.reserve(request.ip);
    if (attempt === undefined) {
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '초기 설정 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    const releaseSlot = passwordSlots.reserve();
    if (releaseSlot === undefined) {
      attempt.cancel();
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '인증 처리량이 가득 찼습니다. 잠시 후 다시 시도하세요.');
    }
    try {
      const session = await app.sfudRuntime.auth.bootstrapAdmin({
        bootstrapToken: requiredString(request.body?.bootstrapToken, '초기 설정 코드'),
        email: requiredString(request.body?.email, '이메일'),
        displayName: requiredString(request.body?.displayName, '표시 이름'),
        password: requiredString(request.body?.password, '비밀번호'),
      });
      attempt.succeed();
      setAuthCookies(request, reply, session.sessionToken, session.csrfToken);
      return reply.code(201).send(toSessionResponse(session));
    } catch (error) {
      attempt.fail();
      return sendAuthError(reply, error);
    } finally {
      releaseSlot();
    }
  });

  app.post<{ Body: LoginBody }>('/api/v1/auth/login', async (request, reply) => {
    if (!hasAllowedOrigin(request, options.publicOrigin)) {
      return sendError(reply, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
    }
    const email = typeof request.body?.email === 'string' ? request.body.email : '';
    const accountKey = email.trim().toLowerCase().slice(0, 254);
    const ipAttempt = ipLimiter.reserve(request.ip);
    if (ipAttempt === undefined) {
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    const accountAttempt = accountLimiter.reserve(accountKey);
    if (accountAttempt === undefined) {
      ipAttempt.cancel();
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    const releaseSlot = passwordSlots.reserve();
    if (releaseSlot === undefined) {
      accountAttempt.cancel();
      ipAttempt.cancel();
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '인증 처리량이 가득 찼습니다. 잠시 후 다시 시도하세요.');
    }
    try {
      const requestPassword = requiredString(request.body?.password, '비밀번호');
      if (requestPassword.length > MAX_PASSWORD_LENGTH) {
        throw new AuthError('INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      const session = await app.sfudRuntime.auth.login(
        requiredString(email, '이메일'),
        requestPassword,
      );
      ipAttempt.succeed();
      accountAttempt.succeed();
      setAuthCookies(request, reply, session.sessionToken, session.csrfToken);
      return reply.send(toSessionResponse(session));
    } catch (error) {
      ipAttempt.fail();
      accountAttempt.fail();
      return sendAuthError(reply, error);
    } finally {
      releaseSlot();
    }
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
    if (session === undefined) return;
    await app.sfudRuntime.auth.revoke(readCookie(request, SESSION_COOKIE)!);
    clearAuthCookies(request, reply);
    return reply.code(204).send();
  });

}

export async function requireAuthenticatedSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { csrf?: boolean; roles?: UserRole[] } = {},
): Promise<{ user: SfudUser; sessionWorkspaceId: string } | undefined> {
  if (options.csrf === true && !hasAllowedOrigin(request, configuredPublicOrigins.get(app))) {
    sendError(reply, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
    return undefined;
  }
  const state = await app.sfudRuntime.auth.sessionState(readCookie(request, SESSION_COOKIE));
  if (state === undefined) {
    sendError(reply, 401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.');
    return undefined;
  }
  if (options.csrf === true && !app.sfudRuntime.auth.verifyCsrf(readHeader(request, 'x-sfud-csrf'), state.csrfTokenHash)) {
    sendError(reply, 403, 'CSRF_DENIED', '요청 검증 토큰이 올바르지 않습니다.');
    return undefined;
  }
  if (options.roles !== undefined && !options.roles.includes(state.user.role)) {
    sendError(reply, 403, 'AUTHORIZATION_DENIED', '이 작업을 실행할 권한이 없습니다.');
    return undefined;
  }
  return { user: state.user, sessionWorkspaceId: state.sessionWorkspaceId };
}

export async function isRequestSessionActive(app: FastifyInstance, request: FastifyRequest): Promise<boolean> {
  return await app.sfudRuntime.auth.sessionState(readCookie(request, SESSION_COOKIE)) !== undefined;
}

function setAuthCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionToken: string,
  csrfToken: string,
): void {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  reply.header('set-cookie', [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
    `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
  ]);
  reply.header('cache-control', 'no-store');
}

function clearAuthCookies(request: FastifyRequest, reply: FastifyReply): void {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  reply.header('set-cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  ]);
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasAllowedOrigin(request: FastifyRequest, publicOrigin?: string): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const expectedOrigin = publicOrigin
      ?? `${request.protocol}://${request.headers.host ?? request.hostname}`;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}이(가) 필요합니다.`);
  return value;
}

function toApiUser(user: SfudUser) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

function toSessionResponse(session: {
  user: SfudUser;
  csrfToken: string;
  expiresAt: string;
}): AuthSessionResponse {
  return { user: toApiUser(session.user), csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}

function sendAuthError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) {
    return sendError(reply, error.code === 'INVALID_CREDENTIALS' ? 401 : 403, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : '인증 요청을 처리하지 못했습니다.';
  return sendError(reply, 400, 'INVALID_AUTH_REQUEST', message);
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } } satisfies ApiErrorResponse);
}

class FailedAttemptLimiter {
  private readonly entries = new Map<string, FailedAttemptEntry>();
  private static readonly MAX_ENTRIES = 10_000;

  public constructor(
    private readonly maximumAttempts: number,
    private readonly windowMs: number,
  ) {}

  public reserve(key: string, now = Date.now()): FailedAttemptReservation | undefined {
    this.pruneExpired(now);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      if (this.entries.size >= FailedAttemptLimiter.MAX_ENTRIES) return undefined;
      entry = { failures: [], reservations: new Map() };
      this.entries.set(key, entry);
    }
    const activeFailures = entry.failures.filter((expiresAt) => expiresAt > now).length;
    const activeReservations = [...entry.reservations.values()]
      .filter((reservation) => reservation.reservedUntil > now).length;
    if (activeFailures + activeReservations >= this.maximumAttempts) return undefined;

    const reservation = { id: randomUUID(), reservedUntil: now + this.windowMs };
    entry.reservations.set(reservation.id, reservation);
    return new FailedAttemptReservation(this, key, reservation.id);
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      entry.failures = entry.failures.filter((expiresAt) => expiresAt > now);
      if (entry.failures.length === 0 && entry.reservations.size === 0) this.entries.delete(key);
    }
  }

  public finish(key: string, reservationId: string, failed: boolean, now = Date.now()): void {
    const entry = this.entries.get(key);
    if (entry === undefined || !entry.reservations.delete(reservationId)) return;
    if (failed) entry.failures.push(now + this.windowMs);
    this.pruneExpired(now);
  }
}

interface FailedAttemptEntry {
  failures: number[];
  reservations: Map<string, { id: string; reservedUntil: number }>;
}

class FailedAttemptReservation {
  private finished = false;

  public constructor(
    private readonly limiter: FailedAttemptLimiter,
    private readonly key: string,
    private readonly id: string,
  ) {}

  public succeed(): void { this.finish(false); }
  public fail(): void { this.finish(true); }
  public cancel(): void { this.finish(false); }

  private finish(failed: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.limiter.finish(this.key, this.id, failed);
  }
}

class PasswordExecutionLimiter {
  private active = 0;

  public constructor(private readonly maximum: number) {}

  public reserve(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
