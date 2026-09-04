import { once } from 'node:events';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebServer, resolveDefaultAssetsDirectory } from '../src/web/server/app.js';
import { assertSafeBind, openBrowser } from '../src/web/server/start.js';

const servers: Awaited<ReturnType<typeof createWebServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  vi.restoreAllMocks();
});

describe('웹 UI 서버', () => {
  it('공개 health는 최소 정보만, 인증 diagnostics는 운영 정보를 반환한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
    });
    servers.push(server);

    const response = await server.inject('/api/v1/health');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'sfud-ui',
    });
    expect(response.json()).not.toHaveProperty('host');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await server.inject('/api/v1/diagnostics')).statusCode).toBe(401);

    const setup = await server.inject({
      method: 'POST', url: '/api/v1/auth/bootstrap',
      payload: {
        bootstrapToken: server.sfudRuntime.auth.getBootstrapToken(),
        email: 'diagnostics@example.com', displayName: '진단 관리자',
        password: 'diagnostics password value',
      },
    });
    const cookie = (setup.headers['set-cookie'] as string[])
      .map((value) => value.split(';')[0]).join('; ');
    const diagnostics = await server.inject({
      url: '/api/v1/diagnostics', headers: { cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      host: '127.0.0.1', port: 27_546,
      storage: { engine: 'sqlite', status: 'ok' },
      queue: { queuedCount: 0 },
    });
  });

  it('빌드 자산이 없으면 해결 명령이 있는 오류 화면을 제공한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
    });
    servers.push(server);

    const response = await server.inject('/');

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain('npm run build:ui');
  });

  it('명시적 허용 없이 원격 주소 bind를 거부한다', () => {
    expect(() => assertSafeBind('0.0.0.0', false)).toThrow(/--allow-remote/u);
    expect(() => assertSafeBind('0.0.0.0', true)).not.toThrow();
  });

  it('소스와 빌드 실행 모두 프로젝트의 dist/ui를 사용한다', () => {
    const sourcePath = resolveDefaultAssetsDirectory('file:///workspace/src/web/server/app.ts');
    const builtPath = resolveDefaultAssetsDirectory('file:///workspace/dist/web/server/app.js');

    expect(sourcePath).toBe(path.resolve('/workspace/dist/ui'));
    expect(builtPath).toBe(path.resolve('/workspace/dist/ui'));
  });

  it('브라우저 실행 파일이 없어도 비동기 오류를 처리한다', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const child = openBrowser('http://127.0.0.1:27546', '/definitely/missing/sfud-browser-opener');
    expect(child).toBeDefined();
    await once(child!, 'error');

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[UI_BROWSER_OPEN_FAILED]'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('직접 접속하세요'));
  });
});
