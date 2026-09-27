import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import { Type } from '@sinclair/typebox';
import { GitConnectionListResponseSchema, GitConnectionResponseSchema, GitProvidersResponseSchema, GitTokenInputSchema, GitEnvironmentResponseSchema, type GitTokenInput } from '../../api/git-contracts.js';
import { GitCatalogQuerySchema, GitCatalogResponseSchema, type GitCatalogQuery } from '../../api/git-project-contracts.js';
import type { GitConnection } from '../../storage/git-connection-repository.js';
import { GitError } from '../../git/git-errors.js';
import { requireAuthenticatedSession } from './auth-routes.js';

export async function registerGitConnectionRoutes(app: FastifyInstance): Promise<void> {
  const mutation = { csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'] as ('OPERATOR' | 'DEPLOYER' | 'ADMIN')[] };
  app.get('/api/v1/git/providers', { schema: { response: { 200: GitProvidersResponseSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const ready = app.sfudRuntime.gitEnabled && app.sfudRuntime.gitTokenStorageStatus === 'ready';
    return reply.send({ tokenStorage: app.sfudRuntime.gitTokenStorageStatus,
      environmentAvailable: app.sfudRuntime.gitTokens.environmentAvailable(session.user),
      providers: ['github', 'gitlab', 'bitbucket'].map((id) => ({ id, configured: ready,
        publicImport: app.sfudRuntime.gitEnabled, privateImport: ready })) });
  });
  app.post<{ Body: GitTokenInput }>('/api/v1/git/connections', {
    bodyLimit: 20 * 1024,
    errorHandler: tokenRequestError,
    schema: { body: GitTokenInputSchema, response: { 201: GitConnectionResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.code(201).send({ connection: publicConnection(await app.sfudRuntime.gitTokens.register(session.user.id, request.body)) }); }
    catch (error) { return tokenFailure(reply, error); }
  });
  app.put<{ Params: { id: string }; Body: GitTokenInput }>('/api/v1/git/connections/:id', {
    bodyLimit: 20 * 1024,
    errorHandler: tokenRequestError,
    schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), body: GitTokenInputSchema,
      response: { 200: GitConnectionResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.send({ connection: publicConnection(await app.sfudRuntime.gitTokens.register(session.user.id, request.body, request.params.id)) }); }
    catch (error) { return tokenFailure(reply, error); }
  });
  app.post('/api/v1/git/connections/environment', { errorHandler: tokenRequestError, schema: { response: { 200: GitEnvironmentResponseSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.send({ results: (await app.sfudRuntime.gitTokens.importEnvironment(session.user)).map((result) => ({
      provider: result.provider, ...(result.connection === undefined ? {} : { connection: publicConnection(result.connection) }),
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    })) }); }
    catch (error) { return tokenFailure(reply, error); }
  });
  app.get<{ Params: { id: string }; Querystring: GitCatalogQuery }>('/api/v1/git/connections/:id/repositories', {
    schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), querystring: GitCatalogQuerySchema,
      response: { 200: GitCatalogResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'] });
    if (session === undefined) return;
    try { return reply.send(await app.sfudRuntime.gitCatalog.list(session.user.id, request.params.id, request.query)); }
    catch (error) {
      const safe = error instanceof GitError ? error : new GitError('REPOSITORY_UNAVAILABLE');
      if (safe.retryAfterSeconds !== undefined) reply.header('Retry-After', String(safe.retryAfterSeconds));
      return reply.code(safe.code === 'PROVIDER_RATE_LIMITED' ? 429 : safe.code === 'GIT_CONNECTION_REQUIRED' ? 404 : 400)
        .send({ error: { code: safe.code, message: safe.message } });
    }
  });
  app.get('/api/v1/git/connections', { schema: { response: { 200: GitConnectionListResponseSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const connections = await app.sfudRuntime.gitConnections.list(session.user.id);
    return reply.send({ connections: connections.map(({ ownerUserId: _owner, ...connection }) => connection),
      tokenStorage: app.sfudRuntime.gitTokenStorageStatus });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/git/connections/:id', {
    schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }) },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      await app.sfudRuntime.gitConnectionService.disconnect(session.user.id, request.params.id);
      return reply.code(204).send();
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return reply.code(404).send({ error: { code: 'GIT_CONNECTION_REQUIRED', message: 'Git 연결을 찾을 수 없습니다.' } });
    }
  });
}

function publicConnection({ ownerUserId: _owner, ...connection }: GitConnection) { return connection; }
function tokenFailure(reply: FastifyReply, value: unknown) {
  const error = value instanceof GitError ? value : new GitError('GIT_REAUTH_REQUIRED');
  if (error.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.retryAfterSeconds));
  return reply.code(error.code === 'GIT_CONNECTION_REQUIRED' ? 404 : error.code === 'PROVIDER_RATE_LIMITED' ? 429 : 400)
    .send({ error: { code: error.code, message: error.message } });
}

// JSON parser/schema errors can contain fragments of the submitted body.
function tokenRequestError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  const status = error.statusCode !== undefined && [400, 413, 415].includes(error.statusCode) ? error.statusCode : 500;
  return reply.code(status).send({ error: { code: 'INVALID_GIT_TOKEN_REQUEST', message: '토큰 등록 요청 형식 또는 크기가 올바르지 않습니다.' } });
}
