import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SfudUser, UserRole } from '../../auth/composition.js';
import { enterSalesforceUserContext } from '../../salesforce/composition.js';
import type { ApiErrorResponse } from '../../contracts/web-api.js';

export const SESSION_COOKIE = 'sfud_session';
const CSRF_COOKIE = 'sfud_csrf';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const configuredPublicOrigins = new WeakMap<FastifyInstance, string>();

export function configureAuthOrigin(app: FastifyInstance, origin: string | undefined): void {
  if (origin !== undefined) configuredPublicOrigins.set(app, origin);
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
  enterSalesforceUserContext(state.user.id);
  return { user: state.user, sessionWorkspaceId: state.sessionWorkspaceId };
}

export async function isRequestSessionActive(app: FastifyInstance, request: FastifyRequest): Promise<boolean> {
  return await app.sfudRuntime.auth.sessionState(readCookie(request, SESSION_COOKIE)) !== undefined;
}

export function setAuthCookies(
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

export function clearAuthCookies(request: FastifyRequest, reply: FastifyReply): void {
  const secure = isSecureRequest(request) ? '; Secure' : '';
  reply.header('set-cookie', [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  ]);
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
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

export function hasAllowedOrigin(request: FastifyRequest, publicOrigin?: string): boolean {
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

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } } satisfies ApiErrorResponse);
}
