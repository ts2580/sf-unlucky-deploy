import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SfClient } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';
import { startWebUi } from '../src/web/server/start.js';

const emptySfClient: SfClient = {
  async runJson() { return { status: 0, result: { nonScratchOrgs: [] } }; },
};

describe('local 실행 모드', () => {
  it('비밀번호를 설정하면 원격 주소를 유지하고 자동 로그인을 하지 않는다', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'sfud-local-bind-'));
    try {
      const server = await startWebUi({ host: '0.0.0.0', port: 0, localMode: true,
        accessPassword: 'personal-test-password',
        allowRemote: true, trustedProxies: ['127.0.0.1'], publicOrigin: 'https://example.com',
        open: false, dataDirectory });
      try {
        expect(server.server.address()).toMatchObject({ address: '0.0.0.0' });
        expect((await server.inject({ url: '/api/v1/auth/status',
          headers: { host: '127.0.0.1' } })).json()).toMatchObject({ authenticated: false, localMode: true, passwordRequired: true });
        expect((await server.inject({ url: '/api/v1/auth/status',
          headers: { host: 'example.com' } })).statusCode).toBe(200);
      } finally { await server.close(); }
    } finally { await rm(dataDirectory, { recursive: true, force: true }); }
  });

  it('루프백에서 로그인 없이 고정 운영자 세션을 만들고 CSRF를 유지한다', async () => {
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546,
      assetsDirectory: '/missing', databasePath: ':memory:', localMode: true, sfClient: emptySfClient });
    try {
      const host = { host: '127.0.0.1:27546' };
      expect((await server.inject({ url: '/api/v1/auth/status', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
      expect((await server.inject({ url: '/api/v1/auth/status', headers: { host: 'localhost:27546' } })).statusCode).toBe(200);
      expect((await server.inject({ url: '/api/v1/auth/status', headers: { host: 'LOCALHOST:27546' } })).statusCode).toBe(200);
      expect((await server.inject({ url: '/api/v1/auth/status', headers: { host: 'localhost.example:27546' } })).statusCode).toBe(403);
      const status = await server.inject({ url: '/api/v1/auth/status', headers: host });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ localMode: true, setupRequired: false, authenticated: true,
        user: { id: 'local-operator', role: 'ADMIN' } });
      const cookies = (status.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      expect((await server.inject({ url: '/api/v1/workspace', headers: { ...host, cookie: cookies } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: host,
        payload: { email: 'local@sfud.invalid', password: 'password' } })).statusCode).toBe(403);
      expect((await server.inject({ method: 'POST', url: '/api/v1/admin/users', headers: { ...host, cookie: cookies },
        payload: { email: 'other@example.com', displayName: 'Other', role: 'ADMIN', password: 'password' } })).statusCode).toBe(403);
    } finally { await server.close(); }
  });

  it('공개 주소 또는 프록시와 함께 시작하지 않는다', async () => {
    await expect(createWebServer({ host: '0.0.0.0', port: 27_546, localMode: true,
      assetsDirectory: '/missing', databasePath: ':memory:' })).rejects.toThrow(/루프백/u);
    await expect(createWebServer({ host: '127.0.0.1', port: 27_546, localMode: true,
      trustedProxies: ['127.0.0.1'], assetsDirectory: '/missing', databasePath: ':memory:' })).rejects.toThrow(/프록시/u);
    await expect(startWebUi({ host: '0.0.0.0', port: 0, localMode: true,
      allowRemote: true, open: false })).rejects.toThrow(/SFUD_ACCESS_PASSWORD/u);
    await expect(startWebUi({ host: '0.0.0.0', port: 0, localMode: true,
      accessPassword: 'personal-test-password', allowRemote: false, open: false })).rejects.toThrow(/--allow-remote/u);
  });
});
