import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthInfo } from '@salesforce/core';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { SalesforceOAuthError, SalesforceOAuthFlowService } from '../src/web/server/salesforce-oauth.js';
import { createWebServer } from '../src/web/server/app.js';

const PUBLIC_ORIGIN = 'https://deploy.example.test';
const CLIENT_ID = 'clientIdentifier1234567890';
const CLIENT_SECRET = 'clientSecret1234567890';
const previousEnvironment = new Map<string, string | undefined>();
const environmentKeys = ['SFUD_TOKEN_SECRET', 'SFUD_SF_OAUTH_CLIENT_ID', 'SFUD_SF_OAUTH_CLIENT_SECRET'];

beforeAll(() => saveEnvironment());
afterEach(() => {
  for (const key of environmentKeys) {
    const old = previousEnvironment.get(key);
    if (old === undefined) delete process.env[key]; else process.env[key] = old;
  }
});

describe('Salesforce browser OAuth flow service', () => {
  it('fails closed for incomplete configuration and non canonical or insecure origins', () => {
    expect(service({ config: { publicOrigin: PUBLIC_ORIGIN } }).readiness(true)).toEqual({ ready: false, reason: 'not_configured' });
    expect(service({ config: { publicOrigin: 'http://deploy.example.test', clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET } }).readiness(true)).toEqual({ ready: false, reason: 'https_required' });
    expect(service({ config: { publicOrigin: `${PUBLIC_ORIGIN}/path`, clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET } }).readiness(true)).toEqual({ ready: false, reason: 'https_required' });
    expect(service({ config: { publicOrigin: PUBLIC_ORIGIN, clientId: '', clientSecret: CLIENT_SECRET } }).readiness(true).ready).toBe(false);
    expect(service({ config: { publicOrigin: PUBLIC_ORIGIN, clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET } }).readiness(false)).toEqual({ ready: false, reason: 'storage_unavailable' });
  });

  it('creates a fixed callback URL, login consent prompt, and S256 PKCE challenge', () => {
    const flow = service();
    const start = flow.start({ userId: 'user-1', sessionWorkspaceId: 'session-1', alias: 'my-org',
      instanceUrl: 'https://login.salesforce.com', requestOrigin: PUBLIC_ORIGIN,
      requestHost: 'deploy.example.test', requestProtocol: 'https' });
    const url = new URL(start.authorizationUrl);
    expect(url.origin).toBe('https://login.salesforce.com');
    expect(url.pathname).toBe('/services/oauth2/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/api/v1/salesforce/oauth/callback`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('api refresh_token');
    expect(url.searchParams.get('prompt')).toBe('login consent');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(start.cookie).toMatch(/^__Host-sfud_sf_oauth=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300$/u);
    expect(url.searchParams.get('code_verifier')).toBeNull();
  });

  it('rejects forged state, wrong browser cookie, expired state, and replayed callback', () => {
    let time = 1000;
    const flow = service({ now: () => time });
    const first = start(flow);
    const state = authorizationState(first.authorizationUrl);
    expect(() => flow.callback({ state, code: 'code', browserProof: 'wrong' })).toThrow(SalesforceOAuthError);
    expect(() => flow.callback({ state: 'forged', code: 'code', browserProof: cookieValue(first.cookie) })).toThrow(SalesforceOAuthError);
    expect(flow.callback({ state, code: 'secret-code', browserProof: cookieValue(first.cookie) })).toEqual({ id: first.id });
    expect(() => flow.callback({ state, code: 'secret-code', browserProof: cookieValue(first.cookie) })).toThrow(SalesforceOAuthError);
    const expired = start(flow);
    time += 5 * 60_000 + 1;
    expect(() => flow.callback({ state: authorizationState(expired.authorizationUrl), code: 'code',
      browserProof: cookieValue(expired.cookie) })).toThrow(SalesforceOAuthError);
  });

  it('binds completion to the exact user session, serializes concurrent completion, and consumes failures', () => {
    const flow = service();
    const started = start(flow);
    flow.callback({ state: authorizationState(started.authorizationUrl), code: 'code', browserProof: cookieValue(started.cookie) });
    expect(() => flow.beginComplete({ id: started.id, userId: 'user-2', sessionWorkspaceId: 'session-1' }))
      .toThrow(SalesforceOAuthError);
    const attempt = flow.beginComplete({ id: started.id, userId: 'user-1', sessionWorkspaceId: 'session-1' });
    expect(() => flow.beginComplete({ id: started.id, userId: 'user-1', sessionWorkspaceId: 'session-1' }))
      .toThrow(SalesforceOAuthError);
    flow.consume(attempt);
    expect(() => flow.beginComplete({ id: started.id, userId: 'user-1', sessionWorkspaceId: 'session-1' }))
      .toThrow(SalesforceOAuthError);
  });

  it('validates token endpoint policy and parses refresh tokens through Salesforce CLI AuthInfo', async () => {
    let observed: RequestInit | undefined;
    const flow = service({ fetcher: async (_input, init) => {
      observed = init;
      return Response.json({ access_token: '00D000000000001!AQIA...',
        refresh_token: 'RefreshToken_1234567890==', instance_url: 'https://mydomain--dev.sandbox.my.salesforce.com' });
    } });
    const attempt = callback(flow);
    const authUrl = await flow.exchange(attempt);
    expect(observed?.redirect).toBe('error');
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    const parsed = AuthInfo.parseSfdxAuthUrl(authUrl);
    expect(parsed).toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      refreshToken: 'RefreshToken_1234567890==', loginUrl: 'https://mydomain--dev.sandbox.my.salesforce.com' });
  });

  it.each([
    ['missing refresh token', { access_token: 'access-token', instance_url: 'https://my.salesforce.com' }],
    ['untrusted instance URL', { access_token: 'access-token', refresh_token: 'refresh-token', instance_url: 'https://evil.example' }],
    ['unsupported parser delimiters', { access_token: 'access-token', refresh_token: 'refresh/token', instance_url: 'https://my.salesforce.com' }],
  ])('hides and rejects invalid Salesforce response: %s', async (_label, body) => {
    const flow = service({ fetcher: async () => Response.json(body) });
    await expect(flow.exchange(callback(flow))).rejects.toMatchObject({ reason: 'exchange_failed' });
  });

  it('does not expose raw provider errors, follows no redirects, and bounds token response size', async () => {
    const failed = service({ fetcher: async () => new Response('consumer secret and provider detail', { status: 400 }) });
    await expect(failed.exchange(callback(failed))).rejects.toMatchObject({ reason: 'exchange_failed' });
    const tooLarge = service({ fetcher: async () => new Response('x'.repeat(70_000), { status: 200 }) });
    await expect(tooLarge.exchange(callback(tooLarge))).rejects.toMatchObject({ reason: 'exchange_failed' });
    const redirect = service({ fetcher: async () => Response.redirect('https://attacker.example/', 302) });
    await expect(redirect.exchange(callback(redirect))).rejects.toBeDefined();
  });

  it('rejects non Salesforce login hosts and cross origin starts', () => {
    const flow = service();
    expect(() => flow.start({ userId: 'u', sessionWorkspaceId: 's', alias: 'my-org',
      instanceUrl: 'https://login.salesforce.com.evil.test', requestOrigin: PUBLIC_ORIGIN,
      requestHost: 'deploy.example.test', requestProtocol: 'https' })).toThrow(SalesforceOAuthError);
    expect(() => flow.start({ userId: 'u', sessionWorkspaceId: 's', alias: 'my-org',
      instanceUrl: 'https://login.salesforce.com', requestOrigin: 'https://evil.test',
      requestHost: 'evil.test', requestProtocol: 'https' })).toThrow(SalesforceOAuthError);
  });
});

describe('Salesforce browser OAuth API', () => {
  it('completes browser callback without the Strict session cookie and saves only to the starter account', async () => {
    saveEnvironment();
    process.env.SFUD_TOKEN_SECRET = 'o'.repeat(64);
    process.env.SFUD_SF_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.SFUD_SF_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    const authUrls: string[] = [];
    const fakeClient: SfClient = {
      async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
        if (args[0] === 'org' && args[1] === 'login') {
          authUrls.push(options.stdin?.trim() ?? '');
          return { status: 0, result: {} };
        }
        if (args[0] === 'org' && args[1] === 'display') return { status: 0, result: {
          id: '00D000000000001', username: 'alice@example.test', instanceUrl: 'https://my.salesforce.com/',
        } };
        if (args[0] === 'org' && args[1] === 'auth') return { status: 0, result: {
          sfdxAuthUrl: `force://${CLIENT_ID}:${CLIENT_SECRET}:RefreshedToken1234567890==@my.salesforce.com`,
        } };
        return { status: 0, result: { nonScratchOrgs: [] } };
      },
    };
    let tokenExchanges = 0;
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
      databasePath: ':memory:', bootstrapToken: 'oauth-bootstrap', sfClient: fakeClient,
      publicOrigin: PUBLIC_ORIGIN, trustedProxies: ['127.0.0.1'],
      salesforceOAuth: { fetcher: async (_input, init) => {
        tokenExchanges += 1;
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('client_secret')).toBe(CLIENT_SECRET);
        expect(form.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/api/v1/salesforce/oauth/callback`);
        expect(form.get('code_verifier')).toBeTruthy();
        return Response.json({ access_token: '00D000000000001!AQIA...', refresh_token: 'OAuthRefreshToken1234567890==',
          instance_url: 'https://my.salesforce.com' });
      } } });
    try {
      const alice = await login(server, 'alice@example.test');
      const bob = await server.sfudRuntime.auth.createManagedUser({ actorUserId: alice.user.id,
        email: 'bob@example.test', displayName: 'Bob', role: 'DEPLOYER', password: 'bob correct horse battery staple' });
      const bobLogin = await server.sfudRuntime.auth.login(bob.email, 'bob correct horse battery staple');
      const aliceSecondLogin = await server.sfudRuntime.auth.login('alice@example.test', 'alice correct horse battery staple');
      const started = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/start',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { alias: 'alice-org', instanceUrl: 'https://login.salesforce.com' } });
      expect(started.statusCode).toBe(200);
      const startBody = started.json<{ id: string; authorizationUrl: string }>();
      const callbackCookie = String(started.headers['set-cookie']).split(';')[0];
      expect(callbackCookie).toMatch(/^__Host-sfud_sf_oauth=/u);
      const state = new URL(startBody.authorizationUrl).searchParams.get('state')!;
      const callback = await server.inject({ method: 'GET',
        url: `/api/v1/salesforce/oauth/callback?state=${encodeURIComponent(state)}&code=oauth-code`,
        headers: { host: 'deploy.example.test', cookie: callbackCookie, 'x-forwarded-proto': 'https' } });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toBe(`${PUBLIC_ORIGIN}/auth?sfudSalesforceOAuth=${startBody.id}`);
      expect(callback.headers.location).not.toContain('oauth-code');
      const otherAliceSession = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { host: 'deploy.example.test', 'x-forwarded-proto': 'https',
          cookie: `sfud_session=${encodeURIComponent(aliceSecondLogin.sessionToken)}; sfud_csrf=${encodeURIComponent(aliceSecondLogin.csrfToken)}`,
          'x-sfud-csrf': aliceSecondLogin.csrfToken, origin: PUBLIC_ORIGIN }, payload: { flowId: startBody.id } });
      expect(otherAliceSession.statusCode).toBe(409);
      const bobWrongSession = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { host: 'deploy.example.test', 'x-forwarded-proto': 'https',
          cookie: `sfud_session=${encodeURIComponent(bobLogin.sessionToken)}; sfud_csrf=${encodeURIComponent(bobLogin.csrfToken)}`,
          'x-sfud-csrf': bobLogin.csrfToken, origin: PUBLIC_ORIGIN }, payload: { flowId: startBody.id } });
      expect(bobWrongSession.statusCode).toBe(409);
      expect(tokenExchanges).toBe(0);
      const completed = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: startBody.id } });
      expect(completed.statusCode).toBe(201);
      expect(tokenExchanges).toBe(1);
      expect(authUrls[0]).toContain('OAuthRefreshToken1234567890==');
      expect((await server.sfudRuntime.sfConnections.list(alice.user.id)).map((item) => item.alias)).toEqual(['alice-org']);
      expect(await server.sfudRuntime.sfConnections.list(bob.id)).toEqual([]);
      const encrypted = await server.sfudRuntime.store.database.get<{ encrypted_auth_url: string }>(
        'SELECT encrypted_auth_url FROM salesforce_connections WHERE owner_user_id = ?', alice.user.id);
      expect(encrypted?.encrypted_auth_url).not.toContain('OAuthRefreshToken1234567890==');
      expect(encrypted?.encrypted_auth_url).not.toContain(CLIENT_SECRET);
      const storedConnection = (await server.sfudRuntime.sfConnections.list(alice.user.id))[0]!;
      expect(await server.sfudRuntime.sfConnections.authUrl(alice.user.id, storedConnection.id, storedConnection.generation))
        .toBe(`force://${CLIENT_ID}:${CLIENT_SECRET}:RefreshedToken1234567890==@my.salesforce.com`);
      const replay = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: startBody.id } });
      expect(replay.statusCode).toBe(409);
      const otherUser = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { cookie: `sfud_session=${encodeURIComponent(bobLogin.sessionToken)}; sfud_csrf=${encodeURIComponent(bobLogin.csrfToken)}`,
          'x-sfud-csrf': bobLogin.csrfToken, origin: PUBLIC_ORIGIN }, payload: { flowId: startBody.id } });
      expect(otherUser.statusCode).toBe(409);
      const reauth = await startApiFlow(server, alice.headers, { connectionId: storedConnection.id, alias: 'renamed-org' });
      await callbackApiFlow(server, reauth.authorizationUrl, reauth.cookie);
      const replaced = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: reauth.id } });
      expect(replaced.statusCode, replaced.body).toBe(201);
      expect(replaced.json().connection).toMatchObject({ id: storedConnection.id, alias: 'renamed-org', generation: storedConnection.generation + 1 });
      const racing = await startApiFlow(server, alice.headers, { connectionId: storedConnection.id, alias: 'renamed-org' });
      await callbackApiFlow(server, racing.authorizationUrl, racing.cookie);
      await server.sfudRuntime.sfConnections.rename(alice.user.id, storedConnection.id, 'latest-org');
      const late = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: racing.id } });
      expect(late.statusCode).toBe(400);
      expect((await server.sfudRuntime.sfConnections.list(alice.user.id)).map((item) => item.alias)).toEqual(['latest-org']);

    } finally { await server.close(); }
  });

  it('does not save a connection when the starting session is revoked during token exchange', async () => {
    saveEnvironment();
    process.env.SFUD_TOKEN_SECRET = 'r'.repeat(64);
    process.env.SFUD_SF_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.SFUD_SF_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    let finishExchange: (response: Response) => void = () => undefined;
    let signalExchangeStarted: () => void = () => undefined;
    const exchangeStarted = new Promise<void>((resolve) => { signalExchangeStarted = resolve; });
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
      databasePath: ':memory:', bootstrapToken: 'oauth-bootstrap', publicOrigin: PUBLIC_ORIGIN,
      trustedProxies: ['127.0.0.1'], salesforceOAuth: { fetcher: async () => {
        signalExchangeStarted();
        return new Promise<Response>((resolve) => { finishExchange = resolve; });
      } } });
    try {
      const alice = await login(server, 'alice@example.test');
      const started = await startApiFlow(server, alice.headers);
      await callbackApiFlow(server, started.authorizationUrl, started.cookie);
      const completing = server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: started.id } });
      await exchangeStarted;
      const sessionCookie = alice.headers.cookie!.split('; ').find((item) => item.startsWith('sfud_session='))!;
      await server.sfudRuntime.auth.revoke(decodeURIComponent(sessionCookie.split('=')[1]!));
      finishExchange(Response.json({ access_token: 'access-token', refresh_token: 'refresh-token123456',
        instance_url: 'https://my.salesforce.com' }));
      const response = await completing;
      expect(response.statusCode).toBe(401);
      expect(await server.sfudRuntime.sfConnections.list(alice.user.id)).toEqual([]);
    } finally { await server.close(); }
  });

  it('keeps setup readiness private, rejects start without CSRF or origin, and returns generic provider errors', async () => {
    saveEnvironment();
    for (const key of environmentKeys) delete process.env[key];
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
      databasePath: ':memory:', bootstrapToken: 'oauth-bootstrap', publicOrigin: PUBLIC_ORIGIN,
      trustedProxies: ['127.0.0.1'] });
    try {
      const alice = await login(server, 'alice@example.test');
      const response = await server.inject({ url: '/api/v1/salesforce/connections', headers: alice.headers });
      expect(response.json()).toMatchObject({ oauth: { ready: false, reason: 'not_configured' } });
      expect(JSON.stringify(response.json())).not.toContain(CLIENT_SECRET);
      const missingCsrf = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/start',
        headers: { cookie: alice.headers.cookie, origin: PUBLIC_ORIGIN },
        payload: { alias: 'my-org', instanceUrl: 'https://login.salesforce.com' } });
      expect(missingCsrf.statusCode).toBe(403);
    } finally { await server.close(); }
  });

  it('keeps provider response details out of the API response', async () => {
    saveEnvironment();
    process.env.SFUD_TOKEN_SECRET = 'e'.repeat(64);
    process.env.SFUD_SF_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.SFUD_SF_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
      databasePath: ':memory:', bootstrapToken: 'oauth-bootstrap', publicOrigin: PUBLIC_ORIGIN,
      trustedProxies: ['127.0.0.1'], salesforceOAuth: {
        fetcher: async () => new Response('client_secret=provider-secret-detail', { status: 400 }),
      } });
    try {
      const alice = await login(server, 'alice@example.test');
      const started = await startApiFlow(server, alice.headers);
      await callbackApiFlow(server, started.authorizationUrl, started.cookie);
      const response = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/complete',
        headers: { ...alice.headers, origin: PUBLIC_ORIGIN }, payload: { flowId: started.id } });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('provider-secret-detail');
      expect(response.body).not.toContain(CLIENT_SECRET);
    } finally { await server.close(); }
  });
});

function service(overrides: Partial<ConstructorParameters<typeof SalesforceOAuthFlowService>[0]> = {}) {
  return new SalesforceOAuthFlowService({
    config: { publicOrigin: PUBLIC_ORIGIN, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, ...overrides,
  });
}

function start(flow: SalesforceOAuthFlowService) {
  return flow.start({ userId: 'user-1', sessionWorkspaceId: 'session-1', alias: 'my-org',
    instanceUrl: 'https://login.salesforce.com', requestOrigin: PUBLIC_ORIGIN,
    requestHost: 'deploy.example.test', requestProtocol: 'https' });
}

function callback(flow: SalesforceOAuthFlowService) {
  const started = start(flow);
  flow.callback({ state: authorizationState(started.authorizationUrl), code: 'authorization-code',
    browserProof: cookieValue(started.cookie) });
  return flow.beginComplete({ id: started.id, userId: 'user-1', sessionWorkspaceId: 'session-1' });
}

function authorizationState(value: string): string { return new URL(value).searchParams.get('state')!; }
function cookieValue(value: string): string { return value.slice(value.indexOf('=') + 1).split(';')[0]!; }

async function login(server: Awaited<ReturnType<typeof createWebServer>>, email: string) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/bootstrap',
    headers: { host: 'deploy.example.test', origin: PUBLIC_ORIGIN, 'x-forwarded-proto': 'https' },
    payload: { bootstrapToken: 'oauth-bootstrap', email, displayName: 'Alice', password: 'alice correct horse battery staple' } });
  if (response.statusCode === 201) {
    const body = response.json<{ user: { id: string }; csrfToken: string }>();
    const cookie = (response.headers['set-cookie'] as string[]).map((entry) => entry.split(';')[0]).join('; ');
    return { user: body.user, headers: { host: 'deploy.example.test', 'x-forwarded-proto': 'https', cookie,
      'x-sfud-csrf': body.csrfToken } };
  }
  throw new Error(`Fixture bootstrap failed: ${response.statusCode}`);
}

async function startApiFlow(server: Awaited<ReturnType<typeof createWebServer>>, headers: Record<string, string>, replacement?: { connectionId: string; alias: string }) {
  const response = await server.inject({ method: 'POST', url: '/api/v1/salesforce/oauth/start',
    headers: { ...headers, origin: PUBLIC_ORIGIN }, payload: { alias: 'my-org', instanceUrl: 'https://login.salesforce.com', ...replacement } });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ id: string; authorizationUrl: string }>();
  return { ...body, cookie: String(response.headers['set-cookie']).split(';')[0]! };
}

async function callbackApiFlow(server: Awaited<ReturnType<typeof createWebServer>>, authorizationUrl: string, cookie: string) {
  const state = authorizationState(authorizationUrl);
  return server.inject({ method: 'GET',
    url: `/api/v1/salesforce/oauth/callback?state=${encodeURIComponent(state)}&code=authorization-code`,
    headers: { host: 'deploy.example.test', cookie, 'x-forwarded-proto': 'https' } });
}

function saveEnvironment(): void {
  for (const key of environmentKeys) {
    if (!previousEnvironment.has(key)) previousEnvironment.set(key, process.env[key]);
  }
}
