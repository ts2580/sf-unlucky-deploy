import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWebServer, type WebServerOptions } from '../src/web/server/app.js';
import { AuthService } from '../src/auth/auth-service.js';

const password = 'personal-access-test-password';
const options: WebServerOptions = {
  host: '0.0.0.0', port: 27546, localMode: true, accessPassword: password,
  assetsDirectory: '/missing', databasePath: ':memory:',
  sfClient: { async runJson() { return { status: 0, result: { nonScratchOrgs: [] } }; } },
};
const headers = { host: '192.168.0.62:27546', origin: 'http://192.168.0.62:27546' };
const cookies = (value: string | string[] | undefined): string => (Array.isArray(value) ? value : [value ?? ''])
  .map((item) => item.split(';')[0]).join('; ');

describe('원격 개인용 접속', () => {
  it('계정 생성 없이 비밀번호로 접속하며 API, CSRF, 로그아웃과 사용자 관리 차단을 유지한다', async () => {
    const app = await createWebServer(options);
    try {
      const status = await app.inject({ url: '/api/v1/auth/status', headers });
      expect(status.json()).toEqual({ localMode: true, passwordRequired: true, setupRequired: false, authenticated: false });
      expect(status.headers['set-cookie']).toBeUndefined();
      for (const url of ['/api/v1/workspace', '/api/v1/diagnostics', '/api/v1/salesforce/connections', '/api/v1/workflow/events']) {
        expect((await app.inject({ url, headers })).statusCode, url).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', headers, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        headers: { ...headers, origin: 'https://attacker.example' }, payload: { password } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers,
        payload: { password: 'incorrect-password' } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password } });
      expect(login.statusCode, login.body).toBe(200);
      expect(login.json().user).toMatchObject({ id: 'local-operator', role: 'ADMIN' });
      const authenticated = { ...headers, cookie: cookies(login.headers['set-cookie']) };
      expect((await app.inject({ url: '/api/v1/auth/status', headers: authenticated })).json()).toMatchObject({ authenticated: true, localMode: true });
      expect((await app.inject({ url: '/api/v1/workspace', headers: authenticated })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/v1/salesforce/connections', headers: authenticated })).json()).toMatchObject({ localMode: true, storageStatus: 'cli' });
      expect((await app.inject({ url: '/api/v1/admin/users', headers: authenticated })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authenticated })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout',
        headers: { ...authenticated, 'x-sfud-csrf': login.json().csrfToken } })).statusCode).toBe(204);
      expect((await app.inject({ url: '/api/v1/diagnostics', headers: authenticated })).statusCode).toBe(401);
      const loggedOut = await app.inject({ url: '/api/v1/auth/status', headers: authenticated });
      expect(loggedOut.json().authenticated).toBe(false);
      expect(loggedOut.headers['set-cookie']).toBeUndefined();
    } finally { await app.close(); }
  });

  it('루프백·위조 프록시 헤더로 비밀번호를 우회하지 못하고 실패 횟수를 제한한다', async () => {
    const app = await createWebServer(options);
    try {
      expect((await app.inject({ url: '/api/v1/auth/status', headers: {
        host: 'localhost:27546', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https',
      } })).json().authenticated).toBe(false);
      const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST',
        url: '/api/v1/auth/login', headers, payload: { password: 'wrong-password' } })));
      expect(results.filter((result) => result.statusCode === 401)).toHaveLength(5);
      expect(results.filter((result) => result.statusCode === 429)).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('HTTPS 프록시에서 공개 Origin을 검사하고 Secure 쿠키를 발급한다', async () => {
    const app = await createWebServer({ ...options, host: '127.0.0.1', publicOrigin: 'https://deploy.example.com', trustedProxies: ['127.0.0.1'] });
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:27546', origin: 'https://deploy.example.com', 'x-forwarded-proto': 'https' }, payload: { password } });
      expect(login.statusCode).toBe(200);
      expect(login.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('; HttpOnly; SameSite=Strict; Max-Age=43200; Secure')]));
      const denied = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password } });
      expect(denied.statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('같은 DB의 이전 무인증 프로세스가 보호 세션을 만들거나 다른 설정의 세션을 공유하지 못한다', async () => {
    const app = await createWebServer(options);
    try {
      const oldLocalProcess = new AuthService(app.sfudRuntime.store.database, undefined);
      await expect(oldLocalProcess.createLocalSession()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      const protectedLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password } });
      expect(protectedLogin.statusCode).toBe(200);
      const sessionToken = cookies(protectedLogin.headers['set-cookie']).match(/sfud_session=([^;]+)/u)![1]!;
      expect(await oldLocalProcess.authenticate(sessionToken)).toBeUndefined();
      await oldLocalProcess.configureLocalAccess(undefined);
      const unprotectedSession = await oldLocalProcess.createLocalSession();
      const status = await app.inject({ url: '/api/v1/auth/status',
        headers: { ...headers, cookie: `sfud_session=${unprotectedSession.sessionToken}` } });
      expect(status.json().authenticated).toBe(false);
      expect((await app.inject({ url: '/api/v1/diagnostics',
        headers: { ...headers, cookie: `sfud_session=${unprotectedSession.sessionToken}` } })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it('보호 활성화·비밀번호 교체 시 이전 세션을 폐기하고 동일 비밀번호 재시작은 유지한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfud-personal-access-'));
    const databasePath = join(root, 'sfud.db');
    const { accessPassword: _password, ...unprotected } = options;
    let app = await createWebServer({ ...unprotected, host: '127.0.0.1', databasePath });
    try {
      const local = await app.inject({ url: '/api/v1/auth/status', headers: { host: 'localhost' } });
      const oldCookies = cookies(local.headers['set-cookie']);
      await app.close();
      app = await createWebServer({ ...options, databasePath });
      expect((await app.inject({ url: '/api/v1/diagnostics', headers: { ...headers, cookie: oldCookies } })).statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password } });
      const authenticated = { ...headers, cookie: cookies(login.headers['set-cookie']) };
      const credential = await app.sfudRuntime.store.database.get<{ password_digest: string }>("SELECT password_digest FROM password_credentials WHERE user_id = 'local-operator'");
      expect(credential?.password_digest).toMatch(/^scrypt\$/u);
      expect(credential?.password_digest).not.toContain(password);
      await app.close();
      app = await createWebServer({ ...options, databasePath });
      expect((await app.inject({ url: '/api/v1/diagnostics', headers: authenticated })).statusCode).toBe(200);
      await app.close();
      app = await createWebServer({ ...options, databasePath, accessPassword: 'replacement-access-password' });
      expect((await app.inject({ url: '/api/v1/diagnostics', headers: authenticated })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password } })).statusCode).toBe(401);
      const changed = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: { password: 'replacement-access-password' } });
      expect(changed.statusCode).toBe(200);
      await app.close();
      app = await createWebServer({ ...unprotected, host: '127.0.0.1', databasePath });
      expect((await app.inject({ url: '/api/v1/diagnostics', headers: { host: 'localhost', cookie: cookies(changed.headers['set-cookie']) } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/auth/status', headers: { host: 'localhost' } })).json()).toMatchObject({ authenticated: true, passwordRequired: false });
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['', 'short', ' '.repeat(12), 'x'.repeat(129)])('잘못된 비밀번호 설정으로 서버를 시작하지 않는다 (%#)', async (accessPassword) => {
    await expect(createWebServer({ ...options, accessPassword })).rejects.toThrow(/SFUD_ACCESS_PASSWORD/u);
  });

  it('다중 사용자 모드에서는 개인용 접속 비밀번호를 무시하지 않고 설정 오류로 알린다', async () => {
    await expect(createWebServer({ ...options, localMode: false })).rejects.toThrow(/LOCAL=true/u);
  });
});
