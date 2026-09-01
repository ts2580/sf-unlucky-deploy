import type { FastifyInstance } from 'fastify';

import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';

interface UpdateSettingsBody {
  testClassSuffix?: unknown;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/settings', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    return reply.send({ settings: await app.sfudRuntime.settings.get(session.user.id) });
  });

  app.put<{ Body: UpdateSettingsBody }>('/api/v1/settings', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      if (typeof request.body?.testClassSuffix !== 'string') {
        throw new Error('테스트 클래스 접미사를 입력하세요.');
      }
      const settings = await app.sfudRuntime.settings.update(
        session.user.id,
        request.body.testClassSuffix,
      );
      return reply.send({ settings });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'INVALID_SETTINGS_REQUEST',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });
}
