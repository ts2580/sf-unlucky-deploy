import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { resolveGitHost } from '../src/git/git-network.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
afterEach(() => vi.resetAllMocks());

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

      vi.mocked(lookup).mockResolvedValue([{ address: '192.168.10.25', family: 4 }] as never);
      expect((await app.inject({ url: '/api/v1/admin/git-allowed-ips', headers })).json()).toEqual({ allowedIps: [], checkPrivateIps: false });
      await expect(resolveGitHost('git.internal.example', app.sfudRuntime.gitAllowedIps.policy)).resolves.toEqual({ address: '192.168.10.25', family: 4 });
      for (const [requestHeaders, status] of [[{}, 401], [operatorHeaders, 403], [{ cookie: headers.cookie }, 403]] as const) {
        expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/git-allowed-ips', headers: requestHeaders,
          payload: { checkPrivateIps: true } })).statusCode).toBe(status);
      }
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { checkPrivateIps: 'invalid' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { checkPrivateIps: true } })).json()).toEqual({ allowedIps: [], checkPrivateIps: true });
      await expect(resolveGitHost('git.internal.example', app.sfudRuntime.gitAllowedIps.policy)).rejects.toMatchObject({ code: 'GIT_HOST_IP_NOT_ALLOWED' });

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
      await expect(resolveGitHost('git.internal.example', app.sfudRuntime.gitAllowedIps.policy)).resolves.toEqual({ address: '192.168.10.25', family: 4 });
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/admin/git-allowed-ips', headers,
        payload: { address: '192.168.10.25' } })).json().allowedIps).toEqual([]);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).not.toContain('192.168.10.25');
      await expect(resolveGitHost('git.internal.example', app.sfudRuntime.gitAllowedIps.policy)).rejects.toMatchObject({ code: 'GIT_HOST_IP_NOT_ALLOWED' });
      await app.inject({ method: 'POST', url: '/api/v1/admin/git-allowed-ips', headers, payload: { address: 'fd00:1234::25' } });
      await app.close();
      app = await createWebServer(options);
      expect((await app.inject({ url: '/api/v1/admin/git-allowed-ips', headers })).json().allowedIps.map((entry: { address: string }) => entry.address))
        .toEqual(['fd00:1234::25']);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).toContain('fd00:1234::25');
      expect(app.sfudRuntime.gitAllowedIps.policy.checkPrivateIps).toBe(true);
      const disabled = await app.inject({ method: 'PATCH', url: '/api/v1/admin/git-allowed-ips', headers, payload: { checkPrivateIps: false } });
      expect(disabled.json()).toMatchObject({ checkPrivateIps: false, allowedIps: [{ address: 'fd00:1234::25' }] });
      await expect(resolveGitHost('git.internal.example', app.sfudRuntime.gitAllowedIps.policy)).resolves.toEqual({ address: '192.168.10.25', family: 4 });
      await app.close();
      app = await createWebServer(options);
      expect(app.sfudRuntime.gitAllowedIps.policy.checkPrivateIps).toBe(false);
      expect(app.sfudRuntime.gitAllowedIps.policy.allowedAddresses).toContain('fd00:1234::25');
      expect(await app.sfudRuntime.store.database.all("SELECT detail_json FROM audit_events WHERE event_type = 'GIT_PRIVATE_IP_CHECK_CHANGED' ORDER BY created_at"))
        .toEqual([{ detail_json: '{"checkPrivateIps":true}' }, { detail_json: '{"checkPrivateIps":false}' }]);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
