import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AuthError } from '../../auth/auth-service.js';
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

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const limiter = new LoginAttemptLimiter();

  app.get('/api/v1/auth/status', async (request): Promise<AuthStatusResponse> => {
    const user = await app.sfudRuntime.auth.authenticate(readCookie(request, SESSION_COOKIE));
    return {
      setupRequired: await app.sfudRuntime.auth.isSetupRequired(),
      authenticated: user !== undefined,
      ...(user === undefined ? {} : { user: toApiUser(user) }),
    };
  });

  app.post<{ Body: BootstrapBody }>('/api/v1/auth/bootstrap', async (request, reply) => {
    if (!hasAllowedOrigin(request)) {
      return sendError(reply, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
    }
    try {
      const session = await app.sfudRuntime.auth.bootstrapAdmin({
        bootstrapToken: requiredString(request.body?.bootstrapToken, '초기 설정 코드'),
        email: requiredString(request.body?.email, '이메일'),
        displayName: requiredString(request.body?.displayName, '표시 이름'),
        password: requiredString(request.body?.password, '비밀번호'),
      });
      setAuthCookies(request, reply, session.sessionToken, session.csrfToken);
      return reply.code(201).send(toSessionResponse(session));
    } catch (error) {
      return sendAuthError(reply, error);
    }
  });

  app.post<{ Body: LoginBody }>('/api/v1/auth/login', async (request, reply) => {
    if (!hasAllowedOrigin(request)) {
      return sendError(reply, 403, 'ORIGIN_DENIED', '허용되지 않은 요청 출처입니다.');
    }
    const email = typeof request.body?.email === 'string' ? request.body.email : '';
    const accountKey = email.trim().toLowerCase().slice(0, 254);
    const keys = [`ip:${request.ip}`, `account:${accountKey}`];
    if (!limiter.consume(keys)) {
      return sendError(reply, 429, 'TOO_MANY_ATTEMPTS', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    try {
      const session = await app.sfudRuntime.auth.login(
        requiredString(email, '이메일'),
        requiredString(request.body?.password, '비밀번호'),
      );
      limiter.clear(keys);
      setAuthCookies(request, reply, session.sessionToken, session.csrfToken);
      return reply.send(toSessionResponse(session));
    } catch (error) {
      return sendAuthError(reply, error);
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
): Promise<{ user: SfudUser } | undefined> {
  if (options.csrf === true && !hasAllowedOrigin(request)) {
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
  return { user: state.user };
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
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hasAllowedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwarded = readHeader(request, 'x-forwarded-proto');
  return request.protocol === 'https' || forwarded?.split(',')[0]?.trim() === 'https';
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

class LoginAttemptLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly WINDOW_MS = 15 * 60 * 1_000;
  private static readonly MAX_ENTRIES = 10_000;

  public consume(keys: string[], now = Date.now()): boolean {
    this.pruneExpired(now);
    const uniqueKeys = [...new Set(keys)];
    const newKeyCount = uniqueKeys.filter((key) => !this.entries.has(key)).length;
    if (this.entries.size + newKeyCount > LoginAttemptLimiter.MAX_ENTRIES) return false;
    if (uniqueKeys.some((key) => {
      const entry = this.entries.get(key);
      return entry !== undefined && entry.count >= LoginAttemptLimiter.MAX_ATTEMPTS;
    })) return false;

    for (const key of uniqueKeys) {
      const entry = this.entries.get(key);
      this.entries.set(key, entry === undefined
        ? { count: 1, resetAt: now + LoginAttemptLimiter.WINDOW_MS }
        : { ...entry, count: entry.count + 1 });
    }
    return true;
  }

  public clear(keys: string[]): void {
    for (const key of keys) this.entries.delete(key);
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
