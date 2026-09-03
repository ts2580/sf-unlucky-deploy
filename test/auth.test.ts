import { describe, expect, it } from 'vitest';

import { createWebServer } from '../src/web/server/app.js';

const bootstrapToken = 'one-time-bootstrap-token';
const password = 'correct horse battery staple';

describe('로컬 관리자 인증', () => {
  it('최초 관리자, 세션, CSRF, 로그아웃과 재로그인을 보호한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
      bootstrapToken,
      trustedProxies: ['127.0.0.1'],
      publicOrigin: 'https://deploy.example.test',
    });

    try {
      expect((await server.inject('/api/v1/auth/status')).json()).toEqual({
        setupRequired: true,
        authenticated: false,
      });

      const denied = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        payload: adminPayload('wrong-token'),
      });
      expect(denied.statusCode).toBe(403);

      const bootstrapped = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: {
          host: 'deploy.example.test',
          origin: 'https://deploy.example.test',
          'x-forwarded-proto': 'https',
        },
        payload: adminPayload(bootstrapToken),
      });
      expect(bootstrapped.statusCode).toBe(201);
      expect(bootstrapped.json()).toMatchObject({
        user: { email: 'admin@example.com', displayName: '관리자', role: 'ADMIN' },
      });
      const cookies = bootstrapped.headers['set-cookie'];
      expect(cookies).toBeInstanceOf(Array);
      expect(cookies).toEqual(expect.arrayContaining([
        expect.stringContaining('sfud_session='),
        expect.stringContaining('sfud_csrf='),
      ]));
      expect(cookies).toEqual(expect.arrayContaining([
        expect.stringContaining('HttpOnly; SameSite=Strict'),
        expect.stringContaining('; Secure'),
      ]));

      const cookieHeader = (cookies as string[]).map((cookie) => cookie.split(';')[0]).join('; ');
      const csrfToken = bootstrapped.json<{ csrfToken: string }>().csrfToken;
      expect(await server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM users'))
        .toEqual({ count: 1 });
      const credential = await server.sfudRuntime.store.database.get<{ password_digest: string }>(
        'SELECT password_digest FROM password_credentials',
      );
      expect(credential?.password_digest).toMatch(/^scrypt\$/u);
      expect(credential?.password_digest).not.toContain(password);
      const storedSession = await server.sfudRuntime.store.database.get<{ token_hash: string }>(
        'SELECT token_hash FROM sessions',
      );
      expect(cookieHeader).not.toContain(storedSession!.token_hash);

      expect((await server.inject('/api/v1/deployment-jobs')).statusCode).toBe(401);
      expect((await server.inject('/api/v1/settings')).statusCode).toBe(401);
      expect((await server.inject({
        url: '/api/v1/deployment-jobs',
        headers: { cookie: cookieHeader },
      })).statusCode).toBe(200);

      expect((await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookieHeader },
      })).statusCode).toBe(403);
      expect((await server.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: cookieHeader, 'x-sfud-csrf': csrfToken },
      })).statusCode).toBe(204);
      expect((await server.inject({
        url: '/api/v1/auth/status',
        headers: { cookie: cookieHeader },
      })).json()).toEqual({ setupRequired: false, authenticated: false });

      expect((await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'admin@example.com', password: 'not the password' },
      })).statusCode).toBe(401);
      expect((await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ADMIN@example.com', password },
      })).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('다른 출처의 브라우저 인증 요청을 거부한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
      bootstrapToken,
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        headers: { host: 'deploy.example.test', origin: 'https://evil.example.test' },
        payload: adminPayload(bootstrapToken),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } });
    } finally {
      await server.close();
    }
  });

  it('이메일을 바꾸어도 동일 IP의 로그인 제한을 우회하지 못한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
      bootstrapToken,
    });
    try {
      expect((await server.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        payload: adminPayload(bootstrapToken),
      })).statusCode).toBe(201);

      for (let index = 0; index < 5; index += 1) {
        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `unknown-${index}@example.com`, password: 'incorrect password value' },
        });
        expect(response.statusCode).toBe(401);
      }
      const blocked = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'another-address@example.com', password },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });
    } finally {
      await server.close();
    }
  });

  it('신뢰한 proxy의 client IP를 분리하고 정상 로그인으로 IP 실패 기록을 지우지 않는다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui', databasePath: ':memory:',
      bootstrapToken, trustedProxies: ['127.0.0.1'],
    });
    try {
      expect((await server.inject({
        method: 'POST', url: '/api/v1/auth/bootstrap', payload: adminPayload(bootstrapToken),
      })).statusCode).toBe(201);
      for (let index = 0; index < 4; index += 1) {
        expect((await loginFrom(server, '198.51.100.10', `unknown-${index}@example.com`, 'wrong')).statusCode)
          .toBe(401);
      }
      expect((await loginFrom(server, '198.51.100.10', 'admin@example.com', password)).statusCode)
        .toBe(200);
      expect((await loginFrom(server, '198.51.100.10', 'fifth@example.com', 'wrong')).statusCode)
        .toBe(401);
      expect((await loginFrom(server, '198.51.100.10', 'sixth@example.com', 'wrong')).statusCode)
        .toBe(429);
      expect((await loginFrom(server, '198.51.100.11', 'other-client@example.com', 'wrong')).statusCode)
        .toBe(401);
    } finally {
      await server.close();
    }
  });

  it('bootstrap 실패를 제한하고 잘못 인코딩된 cookie를 비인증으로 처리한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui', databasePath: ':memory:', bootstrapToken,
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        expect((await server.inject({
          method: 'POST', url: '/api/v1/auth/bootstrap', payload: adminPayload(`wrong-${index}`),
        })).statusCode).toBe(403);
      }
      expect((await server.inject({
        method: 'POST', url: '/api/v1/auth/bootstrap', payload: adminPayload(bootstrapToken),
      })).statusCode).toBe(429);
      expect((await server.inject({
        url: '/api/v1/auth/status', headers: { cookie: 'sfud_session=%E0%A4%A' },
      })).json()).toEqual({ setupRequired: true, authenticated: false });
      expect((await server.inject({
        url: '/api/v1/deployment-jobs', headers: { cookie: 'sfud_session=%E0%A4%A' },
      })).statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('신뢰하지 않은 forwarded proto로 Secure cookie와 Origin 판정을 위조하지 못한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui', databasePath: ':memory:', bootstrapToken,
    });
    try {
      const response = await server.inject({
        method: 'POST', url: '/api/v1/auth/bootstrap',
        headers: {
          host: 'deploy.example.test', origin: 'http://deploy.example.test',
          'x-forwarded-proto': 'https',
        },
        payload: adminPayload(bootstrapToken),
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
        expect.not.stringContaining('; Secure'),
      ]));
    } finally {
      await server.close();
    }
  });
});

async function loginFrom(
  server: Awaited<ReturnType<typeof createWebServer>>,
  address: string,
  email: string,
  loginPassword: string,
) {
  return await server.inject({
    method: 'POST', url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': address },
    payload: { email, password: loginPassword },
  });
}

function adminPayload(token: string) {
  return {
    bootstrapToken: token,
    email: 'admin@example.com',
    displayName: '관리자',
    password,
  };
}
