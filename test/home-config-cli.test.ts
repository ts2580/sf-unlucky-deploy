import { spawn } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const cliFile = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loaderUrl = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ cwd: string; environment: NodeJS.ProcessEnv; configFile: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sfud-config-cli-'));
  temporaryDirectories.push(cwd);
  const directory = path.join(cwd, '.sfud');
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === 'LOCAL' || key.toUpperCase().startsWith('SFUD_')) delete environment[key];
  }
  environment.SFUD_CONFIG_DIR = directory;
  return { cwd, environment, configFile: path.join(directory, 'config.json') };
}

async function run(args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stdoutPath = path.join(cwd, 'stdout.log');
  const stderrPath = path.join(cwd, 'stderr.log');
  const stdoutHandle = await open(stdoutPath, 'w', 0o600);
  const stderrHandle = await open(stderrPath, 'w', 0o600);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', loaderUrl, cliFile, ...args], {
        cwd, env: environment, stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), process.platform === 'win32' ? 60_000 : 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    return { code, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
  } finally { await stdoutHandle.close(); await stderrHandle.close(); }
}

const CLI_TEST_TIMEOUT_MS = process.platform === 'win32' ? 180_000 : 20_000;

describe('홈 설정 CLI 실행 경계', () => {
  it('첫 UI 실행에서 자동 생성하고 환경변수·기존 설정을 보존하며 도움말과 경로 조회는 생성하지 않는다', async () => {
    const { cwd, environment, configFile } = await fixture();
    for (const args of [['--version'], ['ui', '--help'], ['config', 'path']]) {
      expect(await run(args, cwd, environment)).toMatchObject({ code: 0, stderr: '' });
      await expect(lstat(path.dirname(configFile))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // An invalid port stops before binding a socket, after the real CLI preAction hook.
    environment.SFUD_UI_PORT = 'invalid';
    environment.LOCAL = 'false';
    const first = await run(['ui', '--no-open'], cwd, environment);
    expect(first.code).toBe(2);
    expect(first.stderr).toContain('포트는 1부터 65535');
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ version: 1, env: {} });
    const secretsFile = path.join(path.dirname(configFile), 'secrets.env');
    expect(await readFile(secretsFile, 'utf8')).toContain('# SFUD_TOKEN_SECRET=');
    await writeFile(configFile, JSON.stringify({ version: 1, env: { SFUD_UI_PORT: '27550' } }));
    const original = await readFile(configFile);
    expect((await run(['ui', '--no-open'], cwd, environment)).stderr).toContain('포트는 1부터 65535');
    expect(await readFile(configFile)).toEqual(original);
    await rm(secretsFile);
    expect((await run(['ui', '--no-open'], cwd, environment)).stderr).toContain('포트는 1부터 65535');
    expect(await readFile(secretsFile, 'utf8')).toContain('# SFUD_TOKEN_SECRET=');
    expect(await readFile(configFile)).toEqual(original);
  }, CLI_TEST_TIMEOUT_MS);

  it('다른 작업 디렉터리에서 init/path를 실행하고 기존 설정을 보존한다', async () => {
    const { cwd, environment, configFile } = await fixture();
    expect(await run(['config', 'path'], cwd, environment)).toMatchObject({ code: 0, stdout: `${configFile}\n` });
    expect(await run(['config', 'init'], cwd, environment)).toMatchObject({ code: 0, stderr: '' });
    const original = await readFile(configFile, 'utf8');
    expect(await readFile(path.join(path.dirname(configFile), 'secrets.env'), 'utf8')).toContain('# SFUD_TOKEN_SECRET=');
    expect(JSON.parse(original)).toMatchObject({ version: 1, env: { LOCAL: 'true', SFUD_DATA_DIR: 'data/local' } });
    expect((await run(['config', 'init'], cwd, environment)).code).toBe(2);
    expect(await readFile(configFile, 'utf8')).toBe(original);
  }, CLI_TEST_TIMEOUT_MS);

  it('옵션 값으로 받은 --help/-h가 설정 검사를 우회하지 않고 실제 도움말은 비밀 파일을 읽지 않는다', async () => {
    const { cwd, environment, configFile } = await fixture();
    expect(await run(['config', 'init'], cwd, environment)).toMatchObject({ code: 0, stderr: '' });
    const privateValue = 'fixture-value-never-print-in-error';
    await writeFile(configFile, JSON.stringify({ version: 1, env: { NODE_OPTIONS: privateValue } }));
    for (const helpValue of ['--help', '-h']) {
      const rejected = await run(['ui', '--project', helpValue, '--no-open'], cwd, environment);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('CONFIGURATION_ERROR');
      expect(rejected.stdout + rejected.stderr).not.toContain(privateValue);
    }
    await writeFile(path.join(path.dirname(configFile), 'secrets.env'), `INVALID_LINE_${privateValue}\n`, { mode: 0o600 });
    const help = await run(['ui', '--help'], cwd, environment);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(help.stdout + help.stderr).not.toContain(privateValue);
    expect((await run(['--version'], cwd, environment)).code).toBe(0);
    expect((await run(['config', 'path'], cwd, environment)).code).toBe(0);
  }, CLI_TEST_TIMEOUT_MS);
});
