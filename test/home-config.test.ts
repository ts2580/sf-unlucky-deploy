import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWindowsPowerShell } from '../src/config/windows-powershell.js';

import {
  getHomeConfigPaths,
  initializeHomeConfiguration,
  loadHomeConfiguration,
  shouldLoadHomeConfiguration,
} from '../src/config/user-config.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configHome(): Promise<{ root: string; directory: string; environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud home [ACL] & % ! '));
  roots.push(root);
  const directory = path.join(root, '.sfud');
  const environment = { SFUD_CONFIG_DIR: directory };
  if (process.platform === 'win32') {
    await initializeHomeConfiguration(environment);
  } else {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return { root, directory, environment };
}

async function writeConfig(directory: string, env: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1, env }), { mode: 0o600 });
  await chmod(path.join(directory, 'config.json'), 0o600);
}

describe('사용자 홈 설정 보안', { timeout: process.platform === 'win32' ? 120_000 : 5_000 }, () => {
  it.skipIf(process.platform !== 'win32')('Windows PowerShell은 제한된 환경에서 설정 경로 없이 시작하고 종료한다', async () => {
    await runWindowsPowerShell('exit 0', {});
  });

  it('기본 사용자 홈에 빈 설정을 자동 생성하고 기존 실행 모드와 사용자 설정을 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud automatic home '));
    roots.push(root);
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    const environment: NodeJS.ProcessEnv = { LOCAL: 'false' };
    const paths = getHomeConfigPaths(environment);
    expect(paths.directory).toBe(path.join(root, '.sfud'));

    await loadHomeConfiguration(environment);
    expect(JSON.parse(await readFile(paths.configFile, 'utf8'))).toEqual({ version: 1, env: {} });
    expect(environment.LOCAL).toBe('false');
    expect(environment.SFUD_DATA_DIR).toBeUndefined();
    const template = await readFile(paths.secretsFile, 'utf8');
    expect(template).toContain('# SFUD_TOKEN_SECRET=');
    expect(template.trim().split('\n').every((line) => line.startsWith('#'))).toBe(true);
    expect(environment.SFUD_TOKEN_SECRET).toBeUndefined();
    if (process.platform !== 'win32') {
      expect((await lstat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o600);
      expect((await lstat(paths.secretsFile)).mode & 0o777).toBe(0o600);
    }

    await writeConfig(paths.directory, { SFUD_UI_PORT: '27550' });
    const original = await readFile(paths.configFile);
    const nextEnvironment: NodeJS.ProcessEnv = {};
    await loadHomeConfiguration(nextEnvironment);
    expect(nextEnvironment.SFUD_UI_PORT).toBe('27550');
    expect(nextEnvironment.LOCAL).toBeUndefined();
    expect(await readFile(paths.configFile)).toEqual(original);
  });

  it('기존 설정에 secrets.env만 없으면 템플릿을 만들고 기존 비밀값 파일은 보존한다', async () => {
    const { directory } = await configHome();
    await writeConfig(directory, { LOCAL: 'false', SFUD_UI_PORT: '27550' });
    const configFile = path.join(directory, 'config.json');
    const secretsFile = path.join(directory, 'secrets.env');
    await rm(secretsFile, { force: true });
    const originalConfig = await readFile(configFile);
    const environment: NodeJS.ProcessEnv = { SFUD_CONFIG_DIR: directory };
    await loadHomeConfiguration(environment);
    expect(environment.LOCAL).toBe('false');
    expect(environment.SFUD_TOKEN_SECRET).toBeUndefined();
    expect(await readFile(configFile)).toEqual(originalConfig);
    expect(await readFile(secretsFile, 'utf8')).toContain('# SFUD_TOKEN_SECRET=');

    const secret = 'fixture-value-with-at-least-32-characters';
    await writeFile(secretsFile, `SFUD_TOKEN_SECRET=${secret}\n`);
    const originalSecrets = await readFile(secretsFile);
    const nextEnvironment: NodeJS.ProcessEnv = { SFUD_CONFIG_DIR: directory };
    await loadHomeConfiguration(nextEnvironment);
    expect(nextEnvironment.SFUD_TOKEN_SECRET).toBe(secret);
    expect(await readFile(secretsFile)).toEqual(originalSecrets);
    expect(await readFile(configFile)).toEqual(originalConfig);
  });

  it('환경변수 우선, 설정 파일 병합, 파일 상대경로 해석 및 기존 파일 부재 기본값을 유지한다', async () => {
    const { directory, environment } = await configHome();
    await writeConfig(directory, {
      LOCAL: 'true', SFUD_UI_PORT: '27546', SFUD_UI_HOST: '127.0.0.1',
      SFUD_DATA_DIR: 'data/local', SFUD_GIT_TOKEN_KEY_FILE: 'keys/git.key',
    });
    await writeFile(path.join(directory, 'secrets.env'), 'SFUD_TOKEN_SECRET="secret-value-which-must-not-print"\n', { mode: 0o600 });
    await chmod(path.join(directory, 'secrets.env'), 0o600);
    environment.SFUD_UI_PORT = '';
    environment.SFUD_TOKEN_SECRET = '';

    await loadHomeConfiguration(environment);
    expect(environment.LOCAL).toBe('true');
    expect(environment.SFUD_UI_PORT).toBe('');
    expect(environment.SFUD_DATA_DIR).toBe(path.join(directory, 'data/local'));
    expect(environment.SFUD_GIT_TOKEN_KEY_FILE).toBe(path.join(directory, 'keys/git.key'));
    expect(environment.SFUD_TOKEN_SECRET).toBe('');
    expect(getHomeConfigPaths(environment).configFile).toBe(path.join(directory, 'config.json'));

    const absentHome = path.join(directory, 'absent');
    await loadHomeConfiguration({ SFUD_CONFIG_DIR: absentHome });
  });

  it('secrets.env는 config.json이 없어도 로드하고 allowlist 밖의 항목과 malformed line은 거부한다', async () => {
    const { directory, environment } = await configHome();
    await rm(path.join(directory, 'config.json'), { force: true });
    await writeFile(path.join(directory, 'secrets.env'), 'SFUD_SF_OAUTH_CLIENT_ID=client-id\n', { mode: 0o600 });
    await chmod(path.join(directory, 'secrets.env'), 0o600);
    await loadHomeConfiguration(environment);
    expect(environment.SFUD_SF_OAUTH_CLIENT_ID).toBe('client-id');

    await writeFile(path.join(directory, 'secrets.env'), 'NODE_OPTIONS=--require=evil\n', { mode: 0o600 });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/허용되지 않은 비밀 설정 키/u);
    await writeFile(path.join(directory, 'secrets.env'), 'export SFUD_TOKEN_SECRET=private-value\n', { mode: 0o600 });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/잘못된 줄/u);
    await writeFile(path.join(directory, 'secrets.env'), 'SFUD_TOKEN_SECRET="unterminated\n', { mode: 0o600 });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/닫히지 않은/u);
  });

  it('개인용 접속 비밀번호는 secrets.env에서만 읽고 환경변수 우선순위와 비출력을 유지한다', async () => {
    const { directory, environment } = await configHome();
    const privateValue = 'personal-private-password';
    await writeFile(path.join(directory, 'secrets.env'), `SFUD_ACCESS_PASSWORD=${privateValue}\n`, { mode: 0o600 });
    await chmod(path.join(directory, 'secrets.env'), 0o600);
    await loadHomeConfiguration(environment);
    expect(environment.SFUD_ACCESS_PASSWORD).toBe(privateValue);
    const override = { SFUD_CONFIG_DIR: directory, SFUD_ACCESS_PASSWORD: '' };
    await loadHomeConfiguration(override);
    expect(override.SFUD_ACCESS_PASSWORD).toBe('');
    await writeConfig(directory, { SFUD_ACCESS_PASSWORD: privateValue });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/허용되지 않은 설정 키/u);
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.not.toThrow(privateValue);
  });

  it('알 수 없는 키, secret의 JSON 주입, 잘못된 타입과 큰 파일을 값 출력 없이 거부한다', async () => {
    const { directory } = await configHome();
    const privateValue = 'private-secret-value-that-must-not-appear';
    await writeConfig(directory, { SFUD_TOKEN_SECRET: privateValue });
    let errorMessage = '';
    try { await loadHomeConfiguration({ SFUD_CONFIG_DIR: directory }); }
    catch (error) { errorMessage = error instanceof Error ? error.message : String(error); }
    expect(errorMessage).toMatch(/허용되지 않은 설정 키/u);
    expect(errorMessage).not.toContain(privateValue);

    await writeConfig(directory, { LOCAL: true });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/값 형식/u);
    await writeFile(path.join(directory, 'config.json'), ' '.repeat(32 * 1024 + 1), { mode: 0o600 });
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/한도/u);
  });

  it.skipIf(process.platform === 'win32')('POSIX에서 넓은 권한, symlink, hardlink 설정 파일을 읽지 않는다', async () => {
    const { root, directory } = await configHome();
    await writeConfig(directory, { LOCAL: 'true' });
    await chmod(path.join(directory, 'config.json'), 0o644);
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/권한/u);

    await chmod(path.join(directory, 'config.json'), 0o600);
    const source = path.join(root, 'outside.json');
    await writeFile(source, JSON.stringify({ version: 1, env: { LOCAL: 'true' } }), { mode: 0o600 });
    await rm(path.join(directory, 'config.json'));
    await symlink(source, path.join(directory, 'config.json'));
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/형식이 안전하지/u);

    await rm(path.join(directory, 'config.json'));
    await link(source, path.join(directory, 'config.json'));
    await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/형식이 안전하지/u);
  });

  it('기존 unsafe 디렉터리 권한은 자동 수리하지 않고, 상대/빈 override를 거부한다', async () => {
    if (process.platform !== 'win32') {
      const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-home-config-unsafe-'));
      roots.push(root);
      const directory = path.join(root, '.sfud');
      await mkdir(directory, { mode: 0o755 });
      await expect(initializeHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/권한/u);
      await expect(loadHomeConfiguration({ SFUD_CONFIG_DIR: directory })).rejects.toThrow(/권한/u);
      expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    }
    expect(() => getHomeConfigPaths({ SFUD_CONFIG_DIR: 'relative' })).toThrow(/절대 경로/u);
    expect(() => getHomeConfigPaths({ SFUD_CONFIG_DIR: '' })).toThrow(/절대 경로/u);
  });

  it('init은 LOCAL/data 경로를 안전하게 한 번만 만들고 재실행과 동시 실행에서 덮어쓰지 않는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-home-config-init-'));
    roots.push(root);
    const directory = path.join(root, '.sfud');
    const environment = { SFUD_CONFIG_DIR: directory };
    const first = await initializeHomeConfiguration(environment);
    const original = await readFile(first.configFile, 'utf8');
    expect(JSON.parse(original)).toEqual({ version: 1, env: { LOCAL: 'true', SFUD_DATA_DIR: 'data/local' } });
    await expect(initializeHomeConfiguration(environment)).rejects.toThrow(/이미/u);
    expect(await readFile(first.configFile, 'utf8')).toBe(original);
    expect(await readFile(first.configFile, 'utf8')).not.toContain('SECRET');
    if (process.platform !== 'win32') expect((await lstat(first.configFile)).mode & 0o777).toBe(0o600);

    const otherDirectory = path.join(root, 'concurrent');
    const concurrentEnvironment = { SFUD_CONFIG_DIR: otherDirectory };
    const outcomes = await Promise.allSettled([
      initializeHomeConfiguration(concurrentEnvironment),
      initializeHomeConfiguration(concurrentEnvironment),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('help/version와 config path는 설정 파일이나 비밀 파일을 읽을 필요가 없다', () => {
    expect(shouldLoadHomeConfiguration('path')).toBe(false);
    expect(shouldLoadHomeConfiguration('init')).toBe(false);
    expect(shouldLoadHomeConfiguration('ui')).toBe(true);
    expect(shouldLoadHomeConfiguration('compare')).toBe(true);
    expect(shouldLoadHomeConfiguration('deploy')).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('Windows 설정 파일 ACL에서 Everyone 읽기 권한을 거부한다', async () => {
    const { directory, environment } = await configHome();
    const configFile = path.join(directory, 'config.json');
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [IO.File]::GetAccessControl($env:SFUD_ACL_PATH)
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[IO.File]::SetAccessControl($env:SFUD_ACL_PATH, $acl)
`;
    await runWindowsPowerShell(script, { SFUD_ACL_PATH: configFile });
    await expect(loadHomeConfiguration(environment)).rejects.toThrow(/ACL/u);
  });
});
