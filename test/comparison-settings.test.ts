import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';

describe('최대 비교 파일 수 설정', () => {
  it('사용자별 한도·권한·CSRF·정수 경계를 검사하고 재시작 후 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-comparison-settings-'));
    const options = { host: '127.0.0.1', port: 0, databasePath: path.join(root, 'state.db'),
      assetsDirectory: '/missing', bootstrapToken: 'fixture',
      sfClient: { runJson: async () => ({ result: { nonScratchOrgs: [] } }) } };
    let app = await createWebServer(options);
    try {
      const owner = await app.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'fixture',
        email: 'owner@example.com', displayName: 'owner', password: 'fixture-long-password' });
      const headers = { cookie: `sfud_session=${owner.sessionToken}`, 'x-sfud-csrf': owner.csrfToken };
      const viewer = await app.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id,
        email: 'viewer@example.com', displayName: 'viewer', role: 'VIEWER', password: 'fixture-long-password' });
      const viewerAuth = await app.sfudRuntime.auth.login(viewer.email, 'fixture-long-password');
      const viewerHeaders = { cookie: `sfud_session=${viewerAuth.sessionToken}`, 'x-sfud-csrf': viewerAuth.csrfToken };
      const payload = { testClassSuffix: 'Spec', maximumComparisonFiles: 1 };
      expect((await app.inject({ url: '/api/v1/settings' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/settings', headers })).json().settings.maximumComparisonFiles).toBe(2000);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { cookie: headers.cookie }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: viewerHeaders, payload })).statusCode).toBe(403);
      for (const value of [0, -1, 1.5, 50001, '2000', null, true]) {
        expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers,
          payload: { ...payload, maximumComparisonFiles: value } })).statusCode).toBe(400);
      }
      for (const value of [1, 50000]) {
        const response = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers,
          payload: { ...payload, maximumComparisonFiles: value } });
        expect(response.statusCode).toBe(200);
        expect(response.json().settings.maximumComparisonFiles).toBe(value);
      }
      // Legacy suffix-only clients must not reset the limit.
      expect((await app.inject({ method: 'PUT', url: '/api/v1/settings', headers,
        payload: { testClassSuffix: '_Test' } })).json().settings.maximumComparisonFiles).toBe(50000);
      expect((await app.inject({ url: '/api/v1/settings', headers: viewerHeaders })).json().settings.maximumComparisonFiles).toBe(2000);
      await app.close();
      app = await createWebServer(options);
      expect((await app.inject({ url: '/api/v1/settings', headers })).json()).toEqual({
        settings: { testClassSuffix: '_Test', maximumComparisonFiles: 50000 },
      });
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
