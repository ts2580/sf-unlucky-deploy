import { afterEach, describe, expect, it, vi } from 'vitest';

const oauth = vi.hoisted(() => ({
  create: vi.fn(),
  determineOauthPort: vi.fn(async () => 1717),
}));

vi.mock('@salesforce/core', () => ({ WebOAuthServer: oauth }));

import { createWebServer } from '../src/web/server/app.js';

describe('로컬 Salesforce 브라우저 로그인', () => {
  afterEach(() => vi.clearAllMocks());

  it('기본 OAuth URL을 제공하고 완료 후 CLI 별칭을 저장한다', async () => {
    const aliasSettings = vi.fn(async () => {});
    let finish!: (value: { handleAliasAndDefaultSettings: typeof aliasSettings }) => void;
    const authorization = new Promise<{ handleAliasAndDefaultSettings: typeof aliasSettings }>((resolve) => { finish = resolve; });
    oauth.create.mockResolvedValue({
      start: vi.fn(async () => {}),
      getAuthorizationUrl: () => 'https://login.salesforce.com/services/oauth2/authorize?state=test',
      authorizeAndSave: () => authorization,
    });
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, localMode: true,
      assetsDirectory: '/missing', databasePath: ':memory:' });
    try {
      const host = 'localhost:27546';
      const session = await server.inject({ url: '/api/v1/auth/status', headers: { host } });
      const cookies = (session.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      const csrf = cookies.match(/(?:^|; )sfud_csrf=([^;]+)/u)?.[1];
      expect(csrf).toBeDefined();
      const headers = { host, origin: 'http://localhost:27546', cookie: cookies, 'x-sfud-csrf': decodeURIComponent(csrf!) };
      const started = await server.inject({ method: 'POST', url: '/api/v1/salesforce/local-login', headers,
        payload: { alias: 'dev', instanceUrl: 'https://login.salesforce.com' } });
      expect(started.statusCode).toBe(202);
      expect(started.json()).toMatchObject({ authorizationUrl: expect.stringContaining('login.salesforce.com'), callbackPort: 1717 });
      expect(oauth.create).toHaveBeenCalledWith({ oauthConfig: { loginUrl: 'https://login.salesforce.com' } });
      const id = started.json().id as string;
      expect((await server.inject({ url: `/api/v1/salesforce/local-login/${id}`, headers: { host, cookie: cookies } })).json())
        .toMatchObject({ status: 'PENDING', alias: 'dev' });
      expect((await server.inject({ method: 'POST', url: '/api/v1/salesforce/local-login', headers,
        payload: { alias: 'other', instanceUrl: 'https://test.salesforce.com' } })).statusCode).toBe(409);
      finish({ handleAliasAndDefaultSettings: aliasSettings });
      await vi.waitFor(() => expect(aliasSettings).toHaveBeenCalledWith({ alias: 'dev', setDefault: false, setDefaultDevHub: false }));
      await vi.waitFor(async () => expect((await server.inject({ url: `/api/v1/salesforce/local-login/${id}`,
        headers: { host, cookie: cookies } })).json()).toMatchObject({ status: 'SUCCEEDED' }));
    } finally { await server.close(); }
  });

  it('Salesforce 이외의 로그인 주소는 OAuth 서버를 열지 않는다', async () => {
    const server = await createWebServer({ host: '127.0.0.1', port: 27_546, localMode: true,
      assetsDirectory: '/missing', databasePath: ':memory:' });
    try {
      const host = '127.0.0.1:27546';
      const session = await server.inject({ url: '/api/v1/auth/status', headers: { host } });
      const cookies = (session.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      const csrf = cookies.match(/(?:^|; )sfud_csrf=([^;]+)/u)?.[1];
      const response = await server.inject({ method: 'POST', url: '/api/v1/salesforce/local-login',
        headers: { host, origin: 'http://127.0.0.1:27546', cookie: cookies, 'x-sfud-csrf': decodeURIComponent(csrf!) },
        payload: { alias: 'bad', instanceUrl: 'https://attacker.example' } });
      expect(response.statusCode).toBe(400);
      expect(oauth.create).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
