import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthInfo } from '@salesforce/core';
import { isOrgIdentifier } from '../../salesforce/org-identifier.js';

const OAUTH_COOKIE = 'sfud_sf_oauth';
const ATTEMPT_TTL_MS = 5 * 60_000;
const START_WINDOW_MS = 15 * 60_000;
const MAX_ACTIVE_ATTEMPTS = 128;
const MAX_STARTS_PER_SESSION = 5;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;

export interface SalesforceOAuthConfig {
  publicOrigin?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface SalesforceOAuthDependencies {
  config: SalesforceOAuthConfig;
  fetcher?: typeof fetch;
  now?: () => number;
  random?: (size: number) => Buffer;
}

interface StartAttempt {
  id: string;
  state: string;
  verifier: string;
  browserProofHash: Buffer;
  userId: string;
  sessionWorkspaceId: string;
  alias: string;
  replacement?: { id: string; generation: number };
  loginUrl: URL;
  createdAt: number;
  code?: string;
  failure?: 'denied' | 'failed';
  completing: boolean;
  consumed: boolean;
}

export class SalesforceOAuthFlowService {
  private readonly attempts = new Map<string, StartAttempt>();
  private readonly startsBySession = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly fetcher: typeof fetch;

  public constructor(private readonly dependencies: SalesforceOAuthDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? randomBytes;
    this.fetcher = dependencies.fetcher ?? fetch;
  }

  public readiness(storageReady: boolean): { ready: boolean; reason?: 'not_configured' | 'https_required' | 'storage_unavailable' } {
    const { publicOrigin, clientId, clientSecret } = this.dependencies.config;
    if (publicOrigin === undefined || clientId === undefined || clientSecret === undefined
      || clientId.trim().length === 0 || clientSecret.trim().length === 0
      || clientId.length > 512 || clientSecret.length > 1024
      || !/^[A-Za-z0-9._-]+={0,2}$/u.test(clientId)
      || !/^[A-Za-z0-9._-]+={0,2}$/u.test(clientSecret)
      || /[\u0000-\u0020\u007f]/u.test(clientId) || /[\u0000-\u0020\u007f]/u.test(clientSecret)) {
      return { ready: false, reason: 'not_configured' };
    }
    try {
      const origin = new URL(publicOrigin);
      if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash) return { ready: false, reason: 'https_required' };
    } catch { return { ready: false, reason: 'https_required' }; }
    if (!storageReady) return { ready: false, reason: 'storage_unavailable' };
    return { ready: true };
  }

  public start(input: {
    userId: string;
    sessionWorkspaceId: string;
    alias: string;
    instanceUrl: string;
    replacement?: { id: string; generation: number };
    requestOrigin?: string;
    requestHost: string;
    requestProtocol: string;
  }): { id: string; authorizationUrl: string; cookie: string } {
    const readiness = this.readiness(true);
    if (!readiness.ready) throw new SalesforceOAuthError('not_ready');
    const publicOrigin = this.dependencies.config.publicOrigin!;
    let effectiveOrigin: string;
    try { effectiveOrigin = new URL(`${input.requestProtocol}://${input.requestHost}`).origin; }
    catch { throw new SalesforceOAuthError('origin'); }
    if (input.requestProtocol !== 'https' || input.requestOrigin !== publicOrigin || effectiveOrigin !== publicOrigin) {
      throw new SalesforceOAuthError('origin');
    }
    const alias = input.alias.trim();
    if (!isOrgIdentifier(alias) || alias.length > 120) throw new SalesforceOAuthError('invalid_input');
    const loginUrl = parseSalesforceLoginUrl(input.instanceUrl);
    const currentTime = this.now();
    this.cleanup(currentTime);
    if (this.attempts.size >= MAX_ACTIVE_ATTEMPTS) throw new SalesforceOAuthError('rate_limit');
    const sessionKey = `${input.userId}:${input.sessionWorkspaceId}`;
    const recent = (this.startsBySession.get(sessionKey) ?? []).filter((time) => currentTime - time < START_WINDOW_MS);
    if (recent.length >= MAX_STARTS_PER_SESSION) throw new SalesforceOAuthError('rate_limit');
    recent.push(currentTime);
    this.startsBySession.set(sessionKey, recent);

    const id = this.random(24).toString('base64url');
    const state = this.random(32).toString('base64url');
    const verifier = this.random(32).toString('base64url');
    const browserProof = this.random(32).toString('base64url');
    const attempt: StartAttempt = {
      id, state, verifier, browserProofHash: digest(browserProof), userId: input.userId,
      sessionWorkspaceId: input.sessionWorkspaceId, alias, loginUrl,
      ...(input.replacement === undefined ? {} : { replacement: input.replacement }),
      createdAt: currentTime, completing: false, consumed: false,
    };
    this.attempts.set(state, attempt);

    const authorizationUrl = new URL('/services/oauth2/authorize', loginUrl);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', this.dependencies.config.clientId!);
    authorizationUrl.searchParams.set('redirect_uri', `${publicOrigin}/api/v1/salesforce/oauth/callback`);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('scope', 'api refresh_token');
    authorizationUrl.searchParams.set('prompt', 'login consent');
    return { id, authorizationUrl: authorizationUrl.toString(), cookie: cookieHeader(browserProof) };
  }

  public callback(input: { state?: string; code?: string; error?: string; browserProof?: string }): { id: string } {
    const attempt = typeof input.state === 'string' ? this.attempts.get(input.state) : undefined;
    if (attempt === undefined || attempt.consumed || this.now() - attempt.createdAt > ATTEMPT_TTL_MS) {
      throw new SalesforceOAuthError('callback_invalid');
    }
    if (!safeEqual(attempt.browserProofHash, typeof input.browserProof === 'string' ? digest(input.browserProof) : Buffer.alloc(32))) {
      throw new SalesforceOAuthError('callback_invalid');
    }
    this.attempts.delete(attempt.state);
    if (input.error !== undefined) attempt.failure = 'denied';
    else if (typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 4096
      || /[\u0000-\u0020\u007f]/u.test(input.code)) attempt.failure = 'failed';
    else attempt.code = input.code;
    // Keep only the short-lived completion state after callback proof succeeds.
    this.attempts.set(`id:${attempt.id}`, attempt);
    return { id: attempt.id };
  }

  public beginComplete(input: { id: string; userId: string; sessionWorkspaceId: string }): StartAttempt {
    this.cleanup(this.now());
    const attempt = this.attempts.get(`id:${input.id}`);
    if (attempt === undefined || attempt.consumed || attempt.completing
      || attempt.userId !== input.userId || attempt.sessionWorkspaceId !== input.sessionWorkspaceId) {
      throw new SalesforceOAuthError('completion_invalid');
    }
    attempt.completing = true;
    return attempt;
  }

  public consume(attempt: StartAttempt): void {
    attempt.consumed = true;
    this.attempts.delete(`id:${attempt.id}`);
  }

  public async exchange(attempt: StartAttempt): Promise<string> {
    if (attempt.failure === 'denied') throw new SalesforceOAuthError('denied');
    if (attempt.failure !== undefined || attempt.code === undefined) throw new SalesforceOAuthError('exchange_failed');
    const { clientId, clientSecret } = this.dependencies.config;
    const response = await this.fetcher(new URL('/services/oauth2/token', attempt.loginUrl), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: attempt.code,
        client_id: clientId!, client_secret: clientSecret!,
        redirect_uri: `${this.dependencies.config.publicOrigin}/api/v1/salesforce/oauth/callback`,
        code_verifier: attempt.verifier }).toString(),
    });
    if (!response.ok || response.redirected) throw new SalesforceOAuthError('exchange_failed');
    const body = parseRecord(await readLimitedBody(response));
    const refreshToken = safeCredential(body.refresh_token, 4096);
    const accessTokenValid = safeOpaqueToken(body.access_token, 8192);
    const instanceUrl = typeof body.instance_url === 'string' ? body.instance_url : '';
    if (refreshToken === undefined || !accessTokenValid) throw new SalesforceOAuthError('exchange_failed');
    const instance = validateInstanceUrl(instanceUrl);
    const authUrl = `force://${clientId}:${clientSecret}:${refreshToken}@${instance.hostname}`;
    try {
      const parsed = AuthInfo.parseSfdxAuthUrl(authUrl);
      if (parsed.clientId !== clientId || parsed.clientSecret !== clientSecret
        || parsed.refreshToken !== refreshToken || parsed.loginUrl !== `https://${instance.hostname}`) {
        throw new Error('mismatch');
      }
    } catch { throw new SalesforceOAuthError('exchange_failed'); }
    return authUrl;
  }

  private cleanup(now: number): void {
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.createdAt > ATTEMPT_TTL_MS) this.attempts.delete(key);
    }
    for (const [key, starts] of this.startsBySession) {
      const recent = starts.filter((time) => now - time < START_WINDOW_MS);
      if (recent.length === 0) this.startsBySession.delete(key);
      else this.startsBySession.set(key, recent);
    }
  }
}

export class SalesforceOAuthError extends Error {
  public constructor(public readonly reason: string) { super(reason); }
}

function parseSalesforceLoginUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SalesforceOAuthError('invalid_input'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || !(host === 'login.salesforce.com' || host === 'test.salesforce.com'
      || /^(?:[-a-z0-9]+\.)+my\.salesforce\.com$/u.test(host))) {
    throw new SalesforceOAuthError('invalid_input');
  }
  return url;
}

function validateInstanceUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new SalesforceOAuthError('exchange_failed'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || !/^(?:[-a-z0-9]+\.)+(?:salesforce\.com|force\.com)$/u.test(url.hostname)) {
    throw new SalesforceOAuthError('exchange_failed');
  }
  return url;
}

function safeCredential(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && /^[A-Za-z0-9._-]+={0,2}$/u.test(value) ? value : undefined;
}

function safeOpaqueToken(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch { throw new SalesforceOAuthError('exchange_failed'); }
}

async function readLimitedBody(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_TOKEN_RESPONSE_BYTES) throw new SalesforceOAuthError('exchange_failed');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SalesforceOAuthError('exchange_failed');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }
function safeEqual(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }
function cookieHeader(value: string): string {
  return `__Host-${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`;
}
export function salesforceOAuthCookieName(): string { return `__Host-${OAUTH_COOKIE}`; }
