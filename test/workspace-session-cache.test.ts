import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';

// Separate HTTP requests and fresh browser CSRF sessions must reuse the same
// executing user's snapshot. Explicit refresh is the only navigation-time CLI reload.
describe('Salesforce 인증 목록 세션 보존', () => {
  afterEach(() => vi.restoreAllMocks());

  it('동시 앱 진입·탭 이동·새 브라우저 세션은 CLI 한 번만 조회하고 명시한 새로고침만 다시 조회한다', async () => {
    const runJson = vi.fn(async () => ({ status: 0, result: { nonScratchOrgs: [
      { alias: 'cached-org', username: 'cached@example.com', orgId: '00D000000000001', connectedStatus: 'Connected' },
    ] } }));
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      assetsDirectory: '/missing', databasePath: ':memory:', sfClient: { runJson } });
    const host = '127.0.0.1:27546';
    try {
      const session = await app.inject({ url: '/api/v1/auth/status', headers: { host } });
      const cookie = (session.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      const [workspace, connections] = await Promise.all([
        app.inject({ url: '/api/v1/workspace', headers: { host, cookie } }),
        app.inject({ url: '/api/v1/salesforce/connections', headers: { host, cookie } }),
      ]);
      expect(workspace.statusCode, workspace.body).toBe(200);
      expect(connections.json().connections).toMatchObject([{ alias: 'cached-org' }]);
      expect(runJson).toHaveBeenCalledTimes(1);
      const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
      const nextSession = await app.inject({ url: '/api/v1/auth/status', headers: { host } });
      const nextCookie = (nextSession.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      for (const url of ['/api/v1/workspace', '/api/v1/salesforce/connections', '/api/v1/workspace']) {
        expect((await app.inject({ url, headers: { host, cookie: nextCookie } })).statusCode).toBe(200);
      }
      expect(runJson).toHaveBeenCalledTimes(1);
      const refreshUrl = '/api/v1/salesforce/connections/refresh';
      expect((await app.inject({ method: 'POST', url: refreshUrl, headers: { host, cookie: nextCookie } })).statusCode).toBe(403);
      expect(runJson).toHaveBeenCalledTimes(1);
      const csrf = decodeURIComponent(nextCookie.match(/(?:^|; )sfud_csrf=([^;]+)/u)![1]!);
      const refreshed = await app.inject({ method: 'POST', url: refreshUrl,
        headers: { host, cookie: nextCookie, origin: `http://${host}`, 'x-sfud-csrf': csrf } });
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(refreshed.json().connections).toMatchObject([{ alias: 'cached-org' }]);
      expect(runJson).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });
});
