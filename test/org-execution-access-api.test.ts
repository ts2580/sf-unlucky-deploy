import { describe, expect, it } from 'vitest';

import { createWebServer } from '../src/web/server/app.js';

describe('대상 org 실제 배포 allowlist API', () => {
  it('ADMIN의 CSRF 검증된 부여·조회·회수를 처리한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 27_547, assetsDirectory: '/missing', databasePath: ':memory:',
      bootstrapToken: 'org-access-bootstrap-token',
    });
    try {
      const admin = await bootstrap(server);
      const deployer = await server.sfudRuntime.auth.createManagedUser({
        actorUserId: admin.userId, email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER',
        password: 'deployer correct horse battery staple',
      });

      expect((await server.inject('/api/v1/admin/org-execution-access')).statusCode).toBe(401);
      expect((await server.inject({
        method: 'PUT', url: `/api/v1/admin/org-execution-access/production/${deployer.id}`, headers: { cookie: admin.cookie },
      })).statusCode).toBe(403);
      expect((await server.inject({
        method: 'PUT', url: `/api/v1/admin/org-execution-access/production/${deployer.id}`, headers: admin.headers,
      })).statusCode).toBe(204);
      expect((await server.inject({
        url: '/api/v1/admin/org-execution-access', headers: { cookie: admin.cookie },
      })).json()).toEqual({ grants: [expect.objectContaining({ targetAlias: 'production', userId: deployer.id })] });
      expect((await server.inject({
        method: 'DELETE', url: `/api/v1/admin/org-execution-access/production/${deployer.id}`, headers: admin.headers,
      })).statusCode).toBe(204);
      expect((await server.inject({
        url: '/api/v1/admin/org-execution-access', headers: { cookie: admin.cookie },
      })).json()).toEqual({ grants: [] });
    } finally {
      await server.close();
    }
  });
});

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/bootstrap',
    payload: {
      bootstrapToken: 'org-access-bootstrap-token', email: 'admin@example.com',
      displayName: 'Admin', password: 'admin correct horse battery staple',
    },
  });
  const cookie = (response.headers['set-cookie'] as string[])
    .map((value) => value.split(';')[0]).join('; ');
  const body = response.json<{ user: { id: string }; csrfToken: string }>();
  return { userId: body.user.id, cookie, headers: { cookie, 'x-sfud-csrf': body.csrfToken } };
}
