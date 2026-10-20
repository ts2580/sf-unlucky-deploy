import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { createPrivateHomeFile, initializeHomeConfiguration } from '../src/config/user-config.js';
import { startUiControl, stopWebUi } from '../src/web/server/ui-control.js';

const directories: string[] = [];
const controls: Awaited<ReturnType<typeof startUiControl>>[] = [];
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const timeout = process.platform === 'win32' ? 240_000 : 30_000;

afterEach(async () => {
  for (const control of controls.splice(0)) await control.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(initialize = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-stop-'));
  directories.push(root);
  const directory = path.join(root, 'config');
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.toUpperCase() === 'LOCAL' || key.toUpperCase().startsWith('SFUD_')) delete environment[key];
  environment.SFUD_CONFIG_DIR = directory;
  if (initialize) await initializeHomeConfiguration(environment);
  return { root, directory, environment };
}

describe('sfud UI 정상 종료', { timeout }, () => {
  it('실행 기록이 없는 stop은 설정·DB를 만들지 않는다', async () => {
    const { directory, environment } = await fixture(false);
    expect(await stopWebUi({}, environment)).toEqual({ stopped: false });
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('잘못된 인증을 거절하고 종료 정리가 끝나야 성공 응답을 보낸다', async () => {
    const { directory, environment } = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const control = await startUiControl(directory, { host: '127.0.0.1', port: 27546 }, async () => {
      calls++; entered(); await gate; await control.dispose();
    });
    controls.push(control);
    const file = (await readdir(directory)).find((name) => name.startsWith('ui-'))!;
    const record = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    const invalid = createConnection({ host: '127.0.0.1', port: record.controlPort as number });
    invalid.on('error', () => {});
    const rejected = once(invalid, 'close');
    invalid.end(`${JSON.stringify({ id: record.id, token: '0'.repeat(64), operation: 'stop' })}\n`);
    await rejected;
    expect(calls).toBe(0);
    let completed = false;
    const stop = stopWebUi({}, environment).then((result) => { completed = true; return result; });
    try {
      await started;
      expect(completed).toBe(false);
    } finally { release(); }
    expect(await stop).toMatchObject({ stopped: true, port: 27546 });
    expect(calls).toBe(1);
    expect((await readdir(directory)).some((name) => name.startsWith('ui-'))).toBe(false);
    expect(await stopWebUi({}, environment)).toEqual({ stopped: false });
  });

  it('여러 인스턴스는 선택을 요구하고 지정한 포트만 종료한다', async () => {
    const { directory, environment } = await fixture();
    const calls: number[] = [];
    const first = await startUiControl(directory, { host: '127.0.0.1', port: 27546 }, async () => { calls.push(1); await first.dispose(); });
    const second = await startUiControl(directory, { host: '0.0.0.0', port: 27547 }, async () => { calls.push(2); await second.dispose(); });
    controls.push(first, second);
    await expect(stopWebUi({}, environment)).rejects.toMatchObject({ code: 'UI_STOP_AMBIGUOUS' });
    expect(calls).toEqual([]);
    expect(await stopWebUi({ port: 27547 }, environment)).toMatchObject({ stopped: true, host: '0.0.0.0', port: 27547 });
    expect(calls).toEqual([2]);
    expect(await stopWebUi({ port: 27547 }, environment)).toEqual({ stopped: false });
    expect(await stopWebUi({}, environment)).toMatchObject({ stopped: true, port: 27546 });
  });

  it('종료 정리가 실패하면 성공으로 보고하지 않는다', async () => {
    const { directory, environment } = await fixture();
    controls.push(await startUiControl(directory, { host: '127.0.0.1', port: 27546 }, async () => {
      throw new Error('fixture cleanup failed');
    }));
    await expect(stopWebUi({}, environment)).rejects.toMatchObject({ code: 'UI_STOP_FAILED' });
  });

  it('오래된 PID 기록으로 다른 프로세스를 종료하지 않는다', async () => {
    const { directory, environment } = await fixture();
    const control = await startUiControl(directory, { host: '127.0.0.1', port: 27546 }, async () => {});
    controls.push(control);
    const file = (await readdir(directory)).find((name) => name.startsWith('ui-'))!;
    const bytes = await readFile(path.join(directory, file));
    await control.dispose();
    // Reuse the current test PID deliberately: it must never receive a signal.
    // Recreate a valid private record before exercising stale-instance handling.
    // POSIX mode alone does not set the Windows owner and protected ACL.
    await createPrivateHomeFile(path.join(directory, file), bytes.toString('utf8'));
    expect(await stopWebUi({}, environment)).toEqual({ stopped: false });
    expect(await readFile(path.join(directory, file))).toEqual(bytes);
  });

  it('실제 CLI의 자동 개인 설정·다른 폴더에서 stop·재시작이 같은 SQLite 기록과 키를 보존한다', async () => {
    const { root, directory, environment } = await fixture(false);
    const firstCwd = path.join(root, 'first');
    const secondCwd = path.join(root, 'second');
    await mkdir(firstCwd); await mkdir(secondCwd);
    const children: ChildProcess[] = [];
    const streamAbort = new AbortController();
    try {
      const first = await launchUi(firstCwd, environment, children);
      const authResponse = await fetch(`${first.url}/api/v1/auth/status`);
      const cookie = authResponse.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      const status = await authResponse.json() as { localMode: boolean; authenticated: boolean };
      expect(status).toMatchObject({ localMode: true, authenticated: true });
      const events = await fetch(`${first.url}/api/v1/workflow/events`, { headers: { cookie }, signal: streamAbort.signal });
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: ready');
      const config = await readFile(path.join(directory, 'config.json'));
      const secret = await readFile(path.join(directory, 'secrets.env'));
      const database = path.join(directory, 'data', 'local', 'sfud.db');
      const db = await open({ filename: database, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
      try { await db.exec("CREATE TABLE stop_regression(value TEXT); INSERT INTO stop_regression VALUES ('persisted');"); }
      finally { await db.close(); }
      expect(await runCli(['stop'], secondCwd, environment)).toMatchObject({ code: 0, stderr: '' });
      expect(await exited(first.child)).toBe(0);
      while (!(await reader.read()).done) { /* drain buffered events through server EOF */ }
      const second = await launchUi(secondCwd, environment, children);
      const reopened = await open({ filename: database, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
      try { expect(await reopened.get('SELECT value FROM stop_regression')).toEqual({ value: 'persisted' }); }
      finally { await reopened.close(); }
      expect(await readFile(path.join(directory, 'config.json'))).toEqual(config);
      expect(await readFile(path.join(directory, 'secrets.env'))).toEqual(secret);
      expect(await runCli(['stop', '--port', new URL(second.url).port], firstCwd, environment)).toMatchObject({ code: 0, stderr: '' });
      expect(await exited(second.child)).toBe(0);
      expect(await runCli(['stop'], firstCwd, environment)).toMatchObject({ code: 0, stderr: '' });
      for (const cwd of [firstCwd, secondCwd]) await expect(readdir(path.join(cwd, '.sfud-local'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      streamAbort.abort();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited(child); }
    }
  });
});

async function launchUi(cwd: string, env: NodeJS.ProcessEnv, children: ChildProcess[]) {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ['--import', loader, cli, 'ui', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => { reject(new Error('UI startup timed out')); }, process.platform === 'win32' ? 90_000 : 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`UI exited before startup: ${errors}`)); });
    child.stderr!.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096); });
    child.stdout!.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = /sfud UI: (http:\/\/127\.0\.0\.1:\d+)/u.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
  });
  return { child, url };
}

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', loader, cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), process.platform === 'win32' ? 90_000 : 15_000);
  try { return { code: await exited(child), stdout, stderr }; }
  finally { clearTimeout(timer); }
}

async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return (await once(child, 'exit'))[0] as number | null;
}
