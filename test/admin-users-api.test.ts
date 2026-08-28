import { describe, expect, it } from 'vitest';

import { createWebServer } from '../src/web/server/app.js';

const adminPassword = 'admin correct horse battery staple';
const operatorPassword = 'operator correct horse battery staple';

describe('ADMIN 사용자 관리 API', () => {
  it('계정 생성, 역할 변경, 비활성화와 재활성화를 감사 로그와 함께 처리한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing', databasePath: ':memory:',
      bootstrapToken: 'admin-users-bootstrap-token',
    });
    try {
      const admin = await bootstrap(server);
      expect((await server.inject('/api/v1/admin/users')).statusCode).toBe(401);
      const initial = await server.inject({ url: '/api/v1/admin/users', headers: { cookie: admin.cookie } });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ users: [{
        email: 'admin@example.com', role: 'ADMIN', disabled: false,
      }] });

      expect((await server.inject({
        method: 'POST', url: '/api/v1/admin/users', headers: { cookie: admin.cookie }, payload: {},
      })).statusCode).toBe(403);
      expect((await server.inject({
        method: 'PATCH', url: `/api/v1/admin/users/${admin.userId}`,
        headers: admin.headers,
        payload: { role: 'VIEWER' },
      })).json()).toMatchObject({ error: { code: 'SELF_ROLE_CHANGE_DENIED' } });
      expect((await server.inject({
        method: 'PATCH', url: `/api/v1/admin/users/${admin.userId}`,
        headers: admin.headers,
        payload: { disabled: true },
      })).json()).toMatchObject({ error: { code: 'SELF_DISABLE_DENIED' } });

      const created = await server.inject({
        method: 'POST', url: '/api/v1/admin/users', headers: admin.headers,
        payload: {
          email: 'operator@example.com', displayName: '운영자', role: 'OPERATOR',
          password: operatorPassword,
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain(operatorPassword);
      expect(created.json()).toMatchObject({ user: {
        email: 'operator@example.com', displayName: '운영자', role: 'OPERATOR', disabled: false,
      } });
      const operatorId = created.json<{ user: { id: string } }>().user.id;
      expect((await server.inject({
        method: 'POST', url: '/api/v1/admin/users', headers: admin.headers,
        payload: {
          email: 'OPERATOR@example.com', displayName: '중복', role: 'VIEWER',
          password: operatorPassword,
        },
      })).json()).toMatchObject({ error: { code: 'EMAIL_EXISTS' } });

      const operatorLogin = await login(server, 'operator@example.com', operatorPassword);
      expect((await server.inject({
        url: '/api/v1/admin/users', headers: { cookie: operatorLogin.cookie },
      })).statusCode).toBe(403);

      const promoted = await server.inject({
        method: 'PATCH', url: `/api/v1/admin/users/${operatorId}`,
        headers: admin.headers, payload: { role: 'DEPLOYER' },
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ user: { role: 'DEPLOYER', disabled: false } });
      expect((await server.inject({
        url: '/api/v1/auth/status', headers: { cookie: operatorLogin.cookie },
      })).json()).toMatchObject({ authenticated: true, user: { role: 'DEPLOYER' } });

      const disabled = await server.inject({
        method: 'PATCH', url: `/api/v1/admin/users/${operatorId}`,
        headers: admin.headers, payload: { disabled: true },
      });
      expect(disabled.json()).toMatchObject({ user: { disabled: true } });
      expect((await server.inject({
        url: '/api/v1/auth/status', headers: { cookie: operatorLogin.cookie },
      })).json()).toEqual({ setupRequired: false, authenticated: false });
      expect((await server.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { email: 'operator@example.com', password: operatorPassword },
      })).statusCode).toBe(401);

      const enabled = await server.inject({
        method: 'PATCH', url: `/api/v1/admin/users/${operatorId}`,
        headers: admin.headers, payload: { disabled: false },
      });
      expect(enabled.json()).toMatchObject({ user: { disabled: false } });
      expect((await server.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { email: 'operator@example.com', password: operatorPassword },
      })).statusCode).toBe(200);

      const audits = await server.sfudRuntime.store.database.all<Array<{ event_type: string }>>(`
        SELECT event_type FROM audit_events WHERE entity_type = 'USER' ORDER BY id
      `);
      expect(audits.map((audit) => audit.event_type)).toEqual([
        'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_DISABLED', 'USER_ENABLED',
      ]);
    } finally {
      await server.close();
    }
  });
});

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/bootstrap',
    payload: {
      bootstrapToken: 'admin-users-bootstrap-token', email: 'admin@example.com',
      displayName: '관리자', password: adminPassword,
    },
  });
  const cookie = (response.headers['set-cookie'] as string[])
    .map((value) => value.split(';')[0]).join('; ');
  const body = response.json<{ user: { id: string }; csrfToken: string }>();
  return {
    cookie,
    userId: body.user.id,
    headers: { cookie, 'x-sfud-csrf': body.csrfToken },
  };
}

async function login(
  server: Awaited<ReturnType<typeof createWebServer>>,
  email: string,
  password: string,
) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/login', payload: { email, password },
  });
  const cookie = (response.headers['set-cookie'] as string[])
    .map((value) => value.split(';')[0]).join('; ');
  return { cookie };
}
