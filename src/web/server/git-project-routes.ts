import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { GitImportListResponseSchema, GitImportRequestSchema, GitImportResponseSchema,
  GitRefsRequestSchema, GitRepositoryRequestSchema, GitRepositoryResponseSchema, GitRefsResponseSchema, type GitImportRequestBody, type GitRefsRequest,
  type GitRepositoryRequest } from '../../api/git-project-contracts.js';
import { GitError } from '../../git/git-errors.js';
import type { GitImportRecord } from '../../storage/git-import-repository.js';
import { requireAuthenticatedSession } from './auth-routes.js';

const mutation = { csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'] as ('OPERATOR' | 'DEPLOYER' | 'ADMIN')[] };
const params = Type.Object({ id: Type.String({ format: 'uuid' }) });

export async function registerGitProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/git/registrations', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    return { registrations: await app.sfudRuntime.gitRegistrations.list(session.user.id) };
  });
  app.post<{ Body: GitImportRequestBody }>('/api/v1/git/registrations', {
    schema: { body: GitImportRequestSchema },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.code(201).send({ registration: await app.sfudRuntime.gitRegistrations.register(session.user.id, request.body) }); }
    catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/git/registrations/:id/sync', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return { registration: await app.sfudRuntime.gitRegistrations.sync(request.params.id, session.user.id) }; }
    catch (error) { return sendError(reply, error); }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/git/registrations/:id', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { await app.sfudRuntime.gitRegistrations.remove(request.params.id, session.user.id); return reply.code(204).send(); }
    catch (error) { return sendError(reply, error); }
  });
  app.post<{ Body: GitRepositoryRequest }>('/api/v1/git/repositories/inspect', {
    schema: { body: GitRepositoryRequestSchema, response: { 200: GitRepositoryResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try {
      const repository = await app.sfudRuntime.gitImports.inspect(request.body, undefined, session.user.id);
      return reply.send({ repository });
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Body: GitRefsRequest }>('/api/v1/git/repositories/refs', {
    schema: { body: GitRefsRequestSchema, response: { 200: GitRefsResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.send(await app.sfudRuntime.gitImports.refs(request.body, request.body.kind, request.body.cursor, session.user.id)); }
    catch (error) { return sendError(reply, error); }
  });
  app.post<{ Body: GitImportRequestBody }>('/api/v1/git/imports', {
    schema: { body: GitImportRequestSchema, response: { 202: GitImportResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return reply.code(202).send({ import: publicImport(await app.sfudRuntime.gitImports.create(session.user.id, request.body)) }); }
    catch (error) { return sendError(reply, error); }
  });
  app.get('/api/v1/git/imports', { schema: { response: { 200: GitImportListResponseSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    return reply.send({ imports: (await app.sfudRuntime.gitImports.list(session.user.id)).map(publicImport) });
  });
  app.get<{ Params: { id: string } }>('/api/v1/git/imports/:id', {
    schema: { params, response: { 200: GitImportResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try { return reply.send({ import: publicImport(await app.sfudRuntime.gitImports.get(request.params.id, session.user.id)) }); }
    catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string }; Body: { projectRoot: string } }>('/api/v1/git/imports/:id/select-project', {
    schema: { params, body: Type.Object({ projectRoot: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false }) },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try {
      await app.sfudRuntime.gitImports.select(request.params.id, session.user.id, request.body.projectRoot);
      return reply.code(202).send({ accepted: true });
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/git/imports/:id/cancel', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { await app.sfudRuntime.gitImports.cancel(request.params.id, session.user.id); return reply.code(204).send(); }
    catch (error) { return sendError(reply, error); }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/git/imports/:id', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { await app.sfudRuntime.gitImports.remove(request.params.id, session.user.id); return reply.code(204).send(); }
    catch (error) { return sendError(reply, error); }
  });
}

function publicImport(record: GitImportRecord) {
  return { id: record.id, provider: record.provider, repositoryPath: record.repositoryPath, ref: record.ref,
    ...(record.metadataType === undefined ? {} : { metadataType: record.metadataType }),
    expectedCommitSha: record.expectedCommitSha, status: record.status, projectRoots: record.projectRoots,
    sizeBytes: record.sizeBytes, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode, errorMessage: new GitError(record.errorCode).message }),
    ...(record.provenance === undefined ? {} : { source: {
      id: `git:${record.id}`, kind: 'local', location: 'git', label: record.provenance.repositoryPath, provenance: record.provenance,
    } }) };
}

function sendError(reply: FastifyReply, value: unknown) {
  const error = value instanceof GitError ? value : new GitError('GIT_PROCESS_FAILED');
  const status = error.code === 'IMPORT_EXPIRED' ? 404 : error.code === 'PROVIDER_RATE_LIMITED' ? 429 : 400;
  if (error.retryAfterSeconds !== undefined) reply.header('Retry-After', String(error.retryAfterSeconds));
  return reply.code(status).send({ error: { code: error.code, message: error.message } });
}
