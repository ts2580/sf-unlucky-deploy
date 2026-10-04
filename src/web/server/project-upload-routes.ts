import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { requireAuthenticatedSession } from './auth-routes.js';

/** One-release tombstones for clients that still use the retired folder-upload API. */
export async function registerProjectUploadRoutes(app: FastifyInstance): Promise<void> {
  const removed = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    return reply.code(410).send({ error: {
      code: 'PROJECT_UPLOAD_REMOVED',
      message: '프로젝트 폴더 업로드가 종료되었습니다. 설정에서 Git 프로젝트를 가져오세요.',
    } });
  };
  // Reply before body parsing: no multipart buffering or temporary file allocation.
  app.post('/api/v1/uploads/projects', { onRequest: removed }, removed);
  app.delete('/api/v1/uploads/projects/:id', { onRequest: removed }, removed);
}
