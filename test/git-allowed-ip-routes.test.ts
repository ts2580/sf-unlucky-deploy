import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';

describe('관리자 셀프호스팅 Git 허용 IP', () => {
  it('관리자만 정확한 IP를 즉시 등록·제거하고 재시작 뒤에도 유지한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-allowed-ip-'));
    const options = { host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'), assetsDirectory: '/missing',
      bootstrapToken: 'fixture', sfClient: { runJson: async () => ({ result: { nonScratchOrgs: [] } }) } };
    let app = await createWebServer(options);
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture', email: 'owner@example.com',
        displayName: 'owner', password: 'fixture-long-password' });
      const headers = { cookie: `sfud_session=${owner.sessionToken}`, 'x-sfud-csrf': owner.csrfToken };
      const operator = await app.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id, email: 'operator@example.com',
        displayName: 'operator', role: 'OPERATOR', password: 'fixture-long-password' });
      const operatorSession = await app.sfudRuntime.auth.login(operator.email, 'fixture-long-password');
      const operatorHeaders = { cookie: `sfud_session=${operatorSession.sessionToken}`, 'x-sfud-csrf': operatorSession.csrfToken };

      expect((await app.inject({ url: '/api/v1/admin/git-allowed-ips' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/admin/git-allowed-ips', headers: operatorHeaders })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers: operatorHeaders,
        payload: { address: '192.168.10.25' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers: { cookie: headers.cookie },
        payload: { address: '192.168.10.25' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { address: '192.168.10.0/24' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { address: '192.168.10.25' } })).json().allowedIps.map((entry: { address: string }) => entry.address))
        .toEqual(['192.168.10.25']);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).toContain('192.168.10.25');
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { address: '192.168.10.25' } })).json().allowedIps).toEqual([]);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).not.toContain('192.168.10.25');
      await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers, payload: { address: 'fd00:1234::25' } });
      await app.close();
      app = await createWebServer(options);
      expect((await app.inject({ url: '/api/v1/admin/git-allowed-ips', headers })).json().allowedIps.map((entry: { address: string }) => entry.address))
        .toEqual(['fd00:1234::25']);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).toContain('fd00:1234::25');
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
