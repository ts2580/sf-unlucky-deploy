import { spawn, type ChildProcess } from 'node:child_process';

import type { FastifyInstance } from 'fastify';

import { SfudError } from '../../core/errors.js';
import { createWebServer } from './app.js';

export const DEFAULT_UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT = 27_546;

export interface StartWebUiOptions {
  host: string;
  port: number;
  allowRemote: boolean;
  open: boolean;
  dataDirectory?: string;
  projectPaths?: string[];
  logger?: boolean;
}

export async function startWebUi(options: StartWebUiOptions): Promise<FastifyInstance> {
  assertSafeBind(options.host, options.allowRemote);
  const app = await createWebServer(options);

  try {
    const address = await app.listen({ host: options.host, port: options.port });
    process.stdout.write(`sfud UI: ${address}\n`);
    if (await app.sfudRuntime.auth.isSetupRequired()) {
      process.stdout.write(`sfud 최초 관리자 설정 코드: ${app.sfudRuntime.auth.getBootstrapToken()}\n`);
    }
    if (options.open && process.stdout.isTTY) {
      openBrowser(address);
    }
    return app;
  } catch (error) {
    await app.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new SfudError(
      'UI_START_FAILED',
      `${options.host}:${options.port}에서 웹 UI를 시작하지 못했습니다. ${reason}`,
    );
  }
}

export function assertSafeBind(host: string, allowRemote: boolean): void {
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(host) && !allowRemote) {
    throw new SfudError(
      'REMOTE_BIND_DENIED',
      '원격 접근 가능한 주소는 --allow-remote 없이 사용할 수 없습니다.',
    );
  }
}

export function openBrowser(url: string, commandOverride?: string): ChildProcess | undefined {
  const command = commandOverride ?? (process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      process.stderr.write(
        `[UI_BROWSER_OPEN_FAILED] 브라우저를 자동으로 열지 못했습니다. ${url}에 직접 접속하세요. ${error.message}\n`,
      );
    });
    child.unref();
    return child;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[UI_BROWSER_OPEN_FAILED] 브라우저를 자동으로 열지 못했습니다. ${url}에 직접 접속하세요. ${reason}\n`,
    );
    return undefined;
  }
}
