import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { SfudError } from '../../core/errors.js';
import { requireAuthenticatedSession } from './auth-routes.js';

const ParamsSchema = Type.Object({
  type: Type.Union([Type.Literal('comparison'), Type.Literal('deployment')]),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  userId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const GrantSchema = Type.Object({
  permission: Type.Union([Type.Literal('READ'), Type.Literal('EXECUTE')]),
}, { additionalProperties: false });

export async function registerJobAccessRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: Static<typeof ParamsSchema>; Body: Static<typeof GrantSchema> }>(
    '/api/v1/job-access/:type/:id/:userId',
    { schema: { params: ParamsSchema, body: GrantSchema } },
    async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, {
        csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
      });
      if (session === undefined) return;
      try {
        await app.sfudRuntime.jobAccess.grant(request.params.type, request.params.id,
          session.user.id, request.params.userId, request.body.permission);
        return reply.code(204).send();
      } catch (error) {
        if (!(error instanceof SfudError)) throw error;
        return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: '작업 또는 사용자를 찾을 수 없습니다.' } });
      }
    },
  );
  app.delete<{ Params: Static<typeof ParamsSchema> }>(
    '/api/v1/job-access/:type/:id/:userId', { schema: { params: ParamsSchema } },
    async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, {
        csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
      });
      if (session === undefined) return;
      try {
        await app.sfudRuntime.jobAccess.revoke(request.params.type, request.params.id,
          session.user.id, request.params.userId);
        return reply.code(204).send();
      } catch (error) {
        if (!(error instanceof SfudError)) throw error;
        return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: '작업을 찾을 수 없습니다.' } });
      }
    },
  );
}
