import { execFileSync } from 'node:child_process';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer as createTcpServer } from 'node:net';

import { expect, test } from '@playwright/test';

import type { SfClient } from '../src/salesforce/sf-client.js';
import { createWebServer, resolveDefaultAssetsDirectory } from '../src/web/server/app.js';

test('실제 교차 사이트 브라우저 callback은 Strict 세션 없이 Lax 확인 쿠키로 돌아와 로그인 세션으로 완료한다', async ({ browser }) => {
  const previous = {
    token: process.env.SFUD_SF_TOKEN_SECRET,
    clientId: process.env.SFUD_SF_OAUTH_CLIENT_ID,
    clientSecret: process.env.SFUD_SF_OAUTH_CLIENT_SECRET,
  };
  process.env.SFUD_SF_TOKEN_SECRET = 'e2e-salesforce-token-secret'.repeat(3);
  process.env.SFUD_SF_OAUTH_CLIENT_ID = 'e2eClientIdentifier1234567890';
  process.env.SFUD_SF_OAUTH_CLIENT_SECRET = 'e2eClientSecret1234567890';
  const certificateDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-oauth-https-'));
  let app: Awaited<ReturnType<typeof createWebServer>> | undefined;
  let httpsServer: ReturnType<typeof createHttpsServer> | undefined;
  const callbackCookies: string[] = [];
  try {
    const port = await reservePort();
    const publicOrigin = `https://localhost:${port}`;
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout',
      path.join(certificateDirectory, 'key.pem'), '-out', path.join(certificateDirectory, 'cert.pem'),
      '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const fakeClient: SfClient = {
      async runJson(args) {
        if (args[0] === 'org' && args[1] === 'display') return { status: 0, result: {
          id: '00D000000000001', username: 'browser@example.test', instanceUrl: 'https://my.salesforce.com/',
        } };
        if (args[0] === 'org' && args[1] === 'auth') return { status: 0, result: {
          sfdxAuthUrl: 'force://e2eClientIdentifier1234567890:e2eClientSecret1234567890:RotatedToken1234567890==@my.salesforce.com',
        } };
        return { status: 0, result: {} };
      },
    };
    app = await createWebServer({ host: '127.0.0.1', port, assetsDirectory: resolveDefaultAssetsDirectory(),
      databasePath: ':memory:', bootstrapToken: 'oauth-browser-bootstrap', publicOrigin,
      trustedProxies: ['127.0.0.1'], sfClient: fakeClient,
      salesforceOAuth: { fetcher: async () => Response.json({ access_token: '00D000000000001!AQIA...',
        refresh_token: 'BrowserRefreshToken1234567890==', instance_url: 'https://my.salesforce.com' }) } });
    httpsServer = createHttpsServer({
      key: await readFile(path.join(certificateDirectory, 'key.pem')),
      cert: await readFile(path.join(certificateDirectory, 'cert.pem')),
    }, (request, response) => { void forwardToApp(app!, request, response, callbackCookies); });
    await new Promise<void>((resolve) => httpsServer!.listen(port, '127.0.0.1', resolve));

    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap',
      headers: { host: `localhost:${port}`, origin: publicOrigin, 'x-forwarded-proto': 'https' },
      payload: { bootstrapToken: 'oauth-browser-bootstrap', email: 'browser@example.test',
        displayName: 'Browser OAuth', password: 'browser correct horse battery staple' } });
    expect(bootstrap.statusCode).toBe(201);
    const cookieHeaders = bootstrap.headers['set-cookie'] as string[];
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await context.addCookies(cookieHeaders.map((header) => {
        const [pair] = header.split(';');
        const separator = pair!.indexOf('=');
        const name = pair!.slice(0, separator);
        const value = pair!.slice(separator + 1);
        return { name, value, url: publicOrigin, secure: true,
          httpOnly: name === 'sfud_session', sameSite: 'Strict' as const };
      }));
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.route('https://login.salesforce.com/services/oauth2/authorize**', async (route) => {
        const authorizeUrl = new URL(route.request().url());
        const callback = new URL('/api/v1/salesforce/oauth/callback', publicOrigin);
        callback.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
        callback.searchParams.set('code', 'browser-authorization-code');
        await route.fulfill({ status: 200, contentType: 'text/html', body:
          `<!doctype html><html><body><a href="${callback.toString()}">Approve Salesforce</a></body></html>` });
      });

      await page.goto(`${publicOrigin}/auth`);
      const panel = page.getByRole('region', { name: 'Salesforce 인증' });
      await panel.getByRole('button', { name: '새 연결', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Salesforce 새 연결' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Salesforce 계정 연결' })).toBeVisible();
      await panel.getByLabel('연결 별칭').first().fill('browser-org');
      await panel.getByRole('button', { name: 'Salesforce 계정 연결' }).click();
      await expect(page.getByRole('link', { name: 'Approve Salesforce' })).toBeVisible();
      await page.getByRole('link', { name: 'Approve Salesforce' }).click();
      await expect(page).toHaveURL(`${publicOrigin}/auth`);
      await expect(panel.getByText('Salesforce 연결을 저장했습니다.')).toBeVisible({ timeout: 15_000 });
      await expect(panel.getByText(/browser-org.*browser@example.test/u)).toBeVisible();
      expect(callbackCookies).toHaveLength(1);
      expect(callbackCookies[0]).toContain('__Host-sfud_sf_oauth=');
      expect(callbackCookies[0]).not.toContain('sfud_session=');
      expect(callbackCookies[0]).not.toContain('sfud_csrf=');
      expect(pageErrors).toEqual([]);
    } finally { await context.close(); }
  } finally {
    if (httpsServer !== undefined) await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
    if (app !== undefined) await app.close();
    await rm(certificateDirectory, { recursive: true, force: true });
    restoreEnvironment('SFUD_SF_TOKEN_SECRET', previous.token);
    restoreEnvironment('SFUD_SF_OAUTH_CLIENT_ID', previous.clientId);
    restoreEnvironment('SFUD_SF_OAUTH_CLIENT_SECRET', previous.clientSecret);
  }
});

async function forwardToApp(
  app: NonNullable<Awaited<ReturnType<typeof createWebServer>>>,
  request: IncomingMessage,
  response: ServerResponse,
  callbackCookies: string[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const headers = Object.fromEntries(Object.entries(request.headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
  headers.host = request.headers.host ?? '';
  headers['x-forwarded-proto'] = 'https';
  if (request.url?.startsWith('/api/v1/salesforce/oauth/callback?')) callbackCookies.push(request.headers.cookie ?? '');
  const result = await app.inject({ method: request.method === 'POST' ? 'POST' : 'GET', url: request.url ?? '/', headers,
    ...(body.length === 0 ? {} : { payload: body }) });
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers)) {
    if (value !== undefined && name.toLowerCase() !== 'content-length' && name.toLowerCase() !== 'transfer-encoding') {
      response.setHeader(name, value);
    }
  }
  response.end(result.body);
}

async function reservePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTPS fixture port unavailable');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
