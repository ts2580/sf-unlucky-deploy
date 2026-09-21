import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { SfudError } from '../../core/errors.js';
import { requireAuthenticatedSession } from './auth-routes.js';

const ParamsSchema = Type.Object({
  targetAlias: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }),
  userId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

/** 관리자용 target org 실제 배포 allowlist API. */
export async function registerOrgExecutionAccessRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/admin/org-execution-access', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { roles: ['ADMIN'] });
    if (session === undefined) return;
    return reply.send({ grants: await app.sfudRuntime.orgExecutionAccess.list() });
  });

  app.put<{ Params: Static<typeof ParamsSchema> }>(
    '/api/v1/admin/org-execution-access/:targetAlias/:userId',
    { schema: { params: ParamsSchema } },
    async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true, roles: ['ADMIN'] });
      if (session === undefined) return;
      try {
        await app.sfudRuntime.orgExecutionAccess.grant(request.params.targetAlias, session.user.id, request.params.userId);
        return reply.code(204).send();
      } catch (error) {
        return sendAccessError(reply, error);
      }
    },
  );

  app.delete<{ Params: Static<typeof ParamsSchema> }>(
    '/api/v1/admin/org-execution-access/:targetAlias/:userId',
    { schema: { params: ParamsSchema } },
    async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, { csrf: true, roles: ['ADMIN'] });
      if (session === undefined) return;
      try {
        await app.sfudRuntime.orgExecutionAccess.revoke(request.params.targetAlias, session.user.id, request.params.userId);
        return reply.code(204).send();
      } catch (error) {
        return sendAccessError(reply, error);
      }
    },
  );
}

function sendAccessError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof SfudError) {
    const status = error.code === 'USER_NOT_FOUND' ? 404 : 400;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}
