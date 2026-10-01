import { randomUUID } from 'node:crypto';

import { WebOAuthServer } from '@salesforce/core';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { SfudError } from '../../core/errors.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { isOrgIdentifier } from '../../salesforce/org-identifier.js';
import { isRequestSessionActive, requireAuthenticatedSession } from './auth-routes.js';
import { SalesforceOAuthError, SalesforceOAuthFlowService, salesforceOAuthCookieName,
  type SalesforceOAuthDependencies } from './salesforce-oauth.js';

const RegistrationBody = Type.Object({
  alias: Type.String({ minLength: 1, maxLength: 120 }),
  sfdxAuthUrl: Type.String({ minLength: 40, maxLength: 16_384 }),
}, { additionalProperties: false });
const AliasBody = Type.Object({ alias: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false });

const LocalLoginBody = Type.Object({
  alias: Type.String({ minLength: 1, maxLength: 120 }),
  instanceUrl: Type.String({ minLength: 20, maxLength: 512 }),
}, { additionalProperties: false });

const OAuthStartBody = Type.Object({
  connectionId: Type.Optional(Type.String({ format: 'uuid' })),
  alias: Type.String({ minLength: 1, maxLength: 120 }),
  instanceUrl: Type.String({ minLength: 20, maxLength: 512 }),
}, { additionalProperties: false });
const OAuthCompleteBody = Type.Object({ flowId: Type.String({ minLength: 20, maxLength: 64 }) }, { additionalProperties: false });

interface LocalLoginAttempt {
  id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  alias: string;
  error?: string;
}

export async function registerSalesforceConnectionRoutes(
  app: FastifyInstance,
  options: { publicOrigin?: string; oauth?: Omit<SalesforceOAuthDependencies, 'config'> } = {},
): Promise<void> {
  const oauth = new SalesforceOAuthFlowService({
    ...options.oauth,
    config: {
      ...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
      ...(process.env.SFUD_SF_OAUTH_CLIENT_ID === undefined ? {} : { clientId: process.env.SFUD_SF_OAUTH_CLIENT_ID }),
      ...(process.env.SFUD_SF_OAUTH_CLIENT_SECRET === undefined ? {} : { clientSecret: process.env.SFUD_SF_OAUTH_CLIENT_SECRET }),
    },
  });
  let localLoginAttempt: LocalLoginAttempt | undefined;

  app.post<{ Body: { alias: string; instanceUrl: string } }>('/api/v1/salesforce/local-login',
    { schema: { body: LocalLoginBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      if (!app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE_REQUIRED', message: '로컬 모드에서만 사용할 수 있습니다.' } });
      if (localLoginAttempt?.status === 'PENDING') {
        return reply.code(409).send({ error: { code: 'SALESFORCE_LOGIN_PENDING', message: '진행 중인 Salesforce 로그인을 완료하거나 잠시 기다리세요.' } });
      }
      const alias = request.body.alias.trim();
      if (!isOrgIdentifier(alias)) return reply.code(400).send({ error: { code: 'INVALID_ALIAS', message: '연결 별칭을 입력하세요.' } });
      let loginUrl: string;
      try { loginUrl = salesforceLoginUrl(request.body.instanceUrl); }
      catch (error) { return sendConnectionError(reply, error); }
      const attempt: LocalLoginAttempt = { id: randomUUID(), status: 'PENDING', alias };
      localLoginAttempt = attempt;
      try {
        const callbackPort = await WebOAuthServer.determineOauthPort();
        const oauth = await WebOAuthServer.create({ oauthConfig: { loginUrl } });
        await oauth.start();
        void oauth.authorizeAndSave().then(async (authInfo) => {
          await authInfo.handleAliasAndDefaultSettings({ alias, setDefault: false, setDefaultDevHub: false });
          app.sfudRuntime.workspace.clearOrgCache(session.user.id);
          attempt.status = 'SUCCEEDED';
        }).catch(() => {
          attempt.status = 'FAILED';
          attempt.error = 'Salesforce 로그인에 실패했거나 시간이 초과됐습니다. SSH 터널의 OAuth 콜백 포트를 확인하세요.';
        });
        return reply.code(202).send({ id: attempt.id, authorizationUrl: oauth.getAuthorizationUrl(), callbackPort });
      } catch (error) {
        if (localLoginAttempt === attempt) localLoginAttempt = undefined;
        return sendConnectionError(reply, error);
      }
    });

  app.get<{ Params: { id: string } }>('/api/v1/salesforce/local-login/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    if (!app.sfudRuntime.localMode || localLoginAttempt?.id !== request.params.id) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '로그인 작업을 찾을 수 없습니다.' } });
    }
    return reply.send({ status: localLoginAttempt.status, alias: localLoginAttempt.alias,
      ...(localLoginAttempt.error === undefined ? {} : { error: localLoginAttempt.error }) });
  });

  app.post<{ Body: { alias: string; instanceUrl: string; connectionId?: string } }>('/api/v1/salesforce/oauth/start',
    { schema: { body: OAuthStartBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 OAuth 연결을 사용할 수 없습니다.' } });
      const readiness = oauth.readiness(app.sfudRuntime.sfTokenStorageStatus === 'ready');
      if (!readiness.ready) return reply.code(503).send({ error: { code: 'SALESFORCE_OAUTH_UNAVAILABLE', message: oauthUnavailableMessage(readiness.reason) } });
      try {
        const previous = request.body.connectionId === undefined ? undefined
          : await app.sfudRuntime.sfConnections.get(session.user.id, request.body.connectionId);
        if (request.body.connectionId !== undefined && previous === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
        const started = oauth.start({
          ...(previous === undefined ? {} : { replacement: { id: previous.id, generation: previous.generation } }),
          userId: session.user.id, sessionWorkspaceId: session.sessionWorkspaceId,
          alias: request.body.alias, instanceUrl: request.body.instanceUrl,
          ...(request.headers.origin === undefined ? {} : { requestOrigin: request.headers.origin }),
          requestHost: request.host, requestProtocol: request.protocol });
        reply.header('set-cookie', started.cookie);
        reply.header('cache-control', 'no-store');
        return reply.send({ id: started.id, authorizationUrl: started.authorizationUrl });
      } catch (error) { return sendOAuthError(reply, error); }
    });

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/api/v1/salesforce/oauth/callback', async (request, reply) => {
      if (app.sfudRuntime.localMode || !oauth.readiness(app.sfudRuntime.sfTokenStorageStatus === 'ready').ready) {
        return reply.code(404).type('text/plain; charset=utf-8').send('OAuth 로그인을 완료할 수 없습니다. 인증 설정을 확인하세요.');
      }
      try {
        const callback = oauth.callback({
          ...(request.query.state === undefined ? {} : { state: request.query.state }),
          ...(request.query.code === undefined ? {} : { code: request.query.code }),
          ...(request.query.error === undefined ? {} : { error: request.query.error }),
          ...(readCookie(request.headers.cookie, salesforceOAuthCookieName()) === undefined ? {} : {
            browserProof: readCookie(request.headers.cookie, salesforceOAuthCookieName())!,
          }),
        });
        reply.header('set-cookie', `${salesforceOAuthCookieName()}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        reply.header('cache-control', 'no-store');
        return reply.redirect(`${options.publicOrigin}/auth?sfudSalesforceOAuth=${encodeURIComponent(callback.id)}`);
      } catch {
        return reply.code(400).type('text/plain; charset=utf-8').send('Salesforce 인증을 확인할 수 없습니다. 인증 화면에서 다시 시작하세요.');
      }
    });

  app.post<{ Body: { flowId: string } }>('/api/v1/salesforce/oauth/complete',
    { schema: { body: OAuthCompleteBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 OAuth 연결을 사용할 수 없습니다.' } });
      let attempt;
      try {
        attempt = oauth.beginComplete({ id: request.body.flowId, userId: session.user.id,
          sessionWorkspaceId: session.sessionWorkspaceId });
      } catch (error) { return sendOAuthError(reply, error); }
      try {
        if (!await isRequestSessionActive(app, request)) return oauthFailure(reply);
        const authUrl = await oauth.exchange(attempt);
        if (!await isRequestSessionActive(app, request)) return oauthFailure(reply);
        const identity = await app.sfudRuntime.sfConnectionClient.validateAuthUrl(
          attempt.alias, authUrl, app.sfudRuntime.workspace.defaultProject().realPath);
        if (!await isRequestSessionActive(app, request)) return oauthFailure(reply);
        const connection = await app.sfudRuntime.sfConnections.upsert(
          session.user.id, attempt.alias, identity, identity.authUrl, attempt.replacement);
        app.sfudRuntime.workspace.clearOrgCache(session.user.id);
        return reply.code(201).send({ connection });
      } catch (error) { return sendOAuthError(reply, error); }
      finally { oauth.consume(attempt); }
    });

  app.get<{ Params: { id: string } }>('/api/v1/salesforce/connections/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    if (app.sfudRuntime.localMode) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
    const connection = await app.sfudRuntime.sfConnections.get(session.user.id, request.params.id);
    if (connection === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
    return reply.send({ connection });
  });

  app.post<{ Body: { alias: string; sfdxAuthUrl: string } }>('/api/v1/salesforce/connections',
    { schema: { body: RegistrationBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 sf CLI에서 로그인하세요.' } });
      if (request.protocol !== 'https' && !['127.0.0.1', '::1'].includes(request.hostname)) {
        return reply.code(403).send({ error: { code: 'HTTPS_REQUIRED', message: 'Salesforce 인증 URL 등록에는 HTTPS가 필요합니다.' } });
      }
      try {
        const identity = await app.sfudRuntime.sfConnectionClient.validateAuthUrl(
          request.body.alias, request.body.sfdxAuthUrl, app.sfudRuntime.workspace.defaultProject().realPath);
        const connection = await app.sfudRuntime.sfConnections.upsert(
          session.user.id, request.body.alias, identity, identity.authUrl);
        app.sfudRuntime.workspace.clearOrgCache(session.user.id);
        return reply.code(201).send({ connection });
      } catch (error) { return sendConnectionError(reply, error); }
    });

  app.put<{ Params: { id: string }; Body: { alias: string; sfdxAuthUrl: string } }>('/api/v1/salesforce/connections/:id',
    { schema: { body: RegistrationBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 브라우저로 다시 로그인하세요.' } });
      if (request.protocol !== 'https' && !['127.0.0.1', '::1'].includes(request.hostname)) {
        return reply.code(403).send({ error: { code: 'HTTPS_REQUIRED', message: 'Salesforce 인증 URL 등록에는 HTTPS가 필요합니다.' } });
      }
      const previous = await app.sfudRuntime.sfConnections.get(session.user.id, request.params.id);
      if (previous === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
      try {
        const identity = await app.sfudRuntime.sfConnectionClient.validateAuthUrl(
          request.body.alias, request.body.sfdxAuthUrl, app.sfudRuntime.workspace.defaultProject().realPath);
        if (!await isRequestSessionActive(app, request)) return oauthFailure(reply);
        const connection = await app.sfudRuntime.sfConnections.upsert(session.user.id, request.body.alias, identity,
          identity.authUrl, { id: previous.id, generation: previous.generation });
        app.sfudRuntime.workspace.clearOrgCache(session.user.id);
        return reply.send({ connection });
      } catch (error) { return sendConnectionError(reply, error); }
    });

  app.patch<{ Params: { id: string }; Body: { alias: string } }>('/api/v1/salesforce/connections/:id',
    { schema: { body: AliasBody } }, async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
      if (session === undefined) return;
      const alias = request.body.alias.trim();
      if (!isOrgIdentifier(alias)) return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Salesforce 연결 별칭이 올바르지 않습니다.' } });
      try {
        if (app.sfudRuntime.localMode) {
          if (localLoginAttempt?.status === 'PENDING') return reply.code(409).send({ error: { code: 'SALESFORCE_LOGIN_PENDING', message: '진행 중인 Salesforce 로그인을 먼저 완료하세요.' } });
          app.sfudRuntime.workspace.clearOrgCache(session.user.id);
          const orgs = await app.sfudRuntime.workspace.listOrgs();
          const connection = orgs.find((org) => org.id === request.params.id);
          if (!connection?.username) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
          if (orgs.some((org) => org.alias === alias && org.id !== connection.id)) {
            return reply.code(409).send({ error: { code: 'ALIAS_EXISTS', message: '이미 사용 중인 Salesforce 별칭입니다.' } });
          }
          if (alias !== connection.alias) {
            const cwd = app.sfudRuntime.workspace.defaultProject().realPath;
            await app.sfudRuntime.sfClient.runJson(['alias', 'set', `${alias}=${connection.username}`], { cwd });
            if (connection.alias !== connection.username) await app.sfudRuntime.sfClient.runJson(['alias', 'unset', connection.alias], { cwd });
          }
          app.sfudRuntime.workspace.clearOrgCache(session.user.id);
          return reply.send({ connection: { id: `org:${alias}`, alias, orgId: connection.orgId, username: connection.username,
            status: connection.connected ? 'CONNECTED' : 'REAUTH_REQUIRED' } });
        }
        const connection = await app.sfudRuntime.sfConnections.rename(session.user.id, request.params.id, alias);
        if (connection === undefined) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
        app.sfudRuntime.workspace.clearOrgCache(session.user.id);
        return reply.send({ connection });
      } catch (error) { return sendConnectionError(reply, error); }
    });

  app.delete<{ Params: { id: string } }>('/api/v1/salesforce/connections/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { csrf: true });
    if (session === undefined) return;
    if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 sf CLI에서 연결을 관리하세요.' } });
    if (!await app.sfudRuntime.sfConnections.remove(session.user.id, request.params.id)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' } });
    }
    app.sfudRuntime.workspace.clearOrgCache(session.user.id);
    return reply.code(204).send();
  });
}

function salesforceLoginUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new SfudError('INVALID_ARGUMENT', 'Salesforce 로그인 URL이 올바르지 않습니다.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || (host !== 'login.salesforce.com' && host !== 'test.salesforce.com' && !host.endsWith('.my.salesforce.com'))) {
    throw new SfudError('INVALID_ARGUMENT', 'Salesforce 로그인 주소는 login.salesforce.com, test.salesforce.com 또는 My Domain HTTPS 주소여야 합니다.');
  }
  return url.origin;
}

function sendConnectionError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  const code = error instanceof SfudError ? error.code : 'SALESFORCE_CONNECTION_FAILED';
  const status = error instanceof SfudError && error.code === 'APPROVAL_DENIED' ? 403 : 400;
  return reply.code(status).send({ error: { code, message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } });
}

function sendOAuthError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof SalesforceOAuthError) {
    const denied = error.reason === 'denied';
    const status = error.reason === 'not_ready' ? 503
      : error.reason === 'origin' ? 403
        : error.reason === 'rate_limit' ? 429
          : error.reason === 'completion_invalid' ? 409 : 400;
    return reply.code(status).send({ error: { code: denied ? 'SALESFORCE_OAUTH_DENIED' : 'SALESFORCE_OAUTH_FAILED',
      message: denied ? 'Salesforce 로그인이 취소됐습니다. 다시 시작하세요.'
        : error.reason === 'not_ready' ? 'Salesforce 브라우저 로그인을 사용할 수 없습니다. 서버 설정을 확인하세요.'
          : error.reason === 'origin' ? '등록된 HTTPS 주소에서 다시 시도하세요.'
            : error.reason === 'rate_limit' ? 'Salesforce 로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'
              : error.reason === 'completion_invalid' ? '인증 상태가 만료됐거나 현재 로그인 사용자와 일치하지 않습니다. 다시 시작하세요.'
                : 'Salesforce 로그인을 완료하지 못했습니다. 다시 시작하세요.' } });
  }
  return reply.code(400).send({ error: { code: 'SALESFORCE_OAUTH_FAILED', message: 'Salesforce 로그인을 완료하지 못했습니다. 다시 시작하세요.' } });
}

function oauthUnavailableMessage(reason: 'not_configured' | 'https_required' | 'storage_unavailable' | undefined): string {
  return reason === 'storage_unavailable'
    ? '관리자가 SFUD_TOKEN_SECRET을 설정해야 사용자별 Salesforce 연결을 저장할 수 있습니다.'
    : reason === 'https_required'
      ? 'Salesforce 브라우저 로그인에는 HTTPS 공개 주소가 필요합니다.'
      : '관리자가 Salesforce OAuth 앱과 공개 HTTPS 주소를 설정해야 합니다.';
}

function oauthFailure(reply: { code(statusCode: number): { send(payload: unknown): unknown } }) {
  return reply.code(401).send({ error: { code: 'AUTHENTICATION_REQUIRED', message: '로그인 상태가 바뀌었습니다. 다시 로그인한 뒤 연결을 시작하세요.' } });
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const cookie of cookieHeader?.split(';') ?? []) {
    const [key, ...rest] = cookie.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}
