import { mkdtemp, readFile, readdir, rm, writeFile, rename, lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeHomeConfiguration, readHomeConfigurationSnapshot, saveHomeConfiguration } from '../src/config/user-config.js';
import { runSetup } from '../src/config/setup.js';
import { terminalSetupPrompt, type SetupPrompt } from '../src/config/setup-prompt.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), lstat: vi.fn(actual.lstat) };
});
const directories: string[] = [];
afterEach(async () => { vi.mocked(rename).mockReset(); vi.mocked(lstat).mockReset(); const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'); vi.mocked(rename).mockImplementation(actual.rename); vi.mocked(lstat).mockImplementation(actual.lstat); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(existing = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-setup-'));
  directories.push(root);
  const environment: NodeJS.ProcessEnv = { SFUD_CONFIG_DIR: path.join(root, 'home') };
  if (existing) await initializeHomeConfiguration(environment);
  return { root, environment, snapshot: await readHomeConfigurationSnapshot(environment) };
}
function prompt(answers: string[], interactive = true): SetupPrompt & { output: string[]; requests: { message: string; secret: boolean }[] } {
  const output: string[] = []; const requests: { message: string; secret: boolean }[] = [];
  return { interactive, output, requests, write: (message) => { output.push(message); }, ask: async (message, secret = false) => { requests.push({ message, secret }); const answer = answers.shift(); if (answer === undefined) throw new Error(`unexpected prompt ${message}`); return answer; } };
}
const timeout = process.platform === 'win32' ? 180_000 : 20_000;

describe('개인용 최초 설정', () => {
  it('비대화형 setup은 기다리지 않고 홈·데이터를 생성하지 않는다', async () => {
    const { root, environment } = await fixture(false);
    const terminal = prompt([], false);
    expect(await runSetup(environment, terminal)).toBe(2);
    expect(await readdir(root)).toEqual([]);
    expect(terminal.requests).toEqual([]);
  }, timeout);
  it('새 원격 설정은 숨김 비밀번호 확인과 계획 뒤에만 저장하고 새 키를 생성한다', async () => {
    const { environment } = await fixture(false);
    const password = 'a#\\"bcdefghijk password';
    const terminal = prompt(['2', '', '', '', 'n', password, password, 'y', 'y']);
    expect(await runSetup(environment, terminal)).toBe(0);
    const snapshot = await readHomeConfigurationSnapshot(environment);
    expect(snapshot.configuration).toMatchObject({ LOCAL: 'true', SFUD_UI_HOST: '0.0.0.0', SFUD_DATA_DIR: 'data/local' });
    expect(snapshot.secrets.SFUD_ACCESS_PASSWORD).toBe(password);
    expect(snapshot.secrets.SFUD_TOKEN_SECRET).toHaveLength(43);
    expect(terminal.requests.filter((request) => request.secret)).toHaveLength(2);
    expect(terminal.output.join('')).not.toContain(password);
    expect(terminal.output.join('')).not.toContain(snapshot.secrets.SFUD_TOKEN_SECRET);
    expect(terminal.output.join('')).toContain('--allow-remote');
    expect(await readdir(snapshot.paths.directory)).toEqual(['config.json', 'secrets.env']);
  }, timeout);
  it('기존 호환 키와 비밀 원문을 보존하고 환경변수 이름만 출력한다', async () => {
    const { environment, snapshot } = await fixture();
    const key = 'legacy-secret-'.repeat(4);
    const original = `# keep comments\nSFUD_GIT_TOKEN_SECRET='${key}'\nSFUD_SF_OAUTH_CLIENT_SECRET='old\\path"with#hash'\n`;
    await writeFile(snapshot.paths.secretsFile, original);
    const terminal = prompt(['1', '', '', '', 'n', 'y']);
    expect(await runSetup({ ...environment, SFUD_UI_PORT: '28000' }, terminal)).toBe(0);
    expect(await readFile(snapshot.paths.secretsFile, 'utf8')).toBe(original);
    const loaded = await readHomeConfigurationSnapshot(environment);
    expect(loaded.secrets.SFUD_GIT_TOKEN_SECRET).toBe(key);
    expect(loaded.secrets.SFUD_TOKEN_SECRET).toBeUndefined();
    expect(terminal.output.join('')).toContain('SFUD_UI_PORT');
    expect(terminal.output.join('')).not.toContain(key);
  }, timeout);
  it('빈 환경변수 비밀번호가 홈 값을 덮어쓰면 저장을 거부하고 사용자별 모드를 보존한다', async () => {
    const { environment, snapshot } = await fixture();
    await writeFile(snapshot.paths.secretsFile, "SFUD_ACCESS_PASSWORD='valid-password-123'\n");
    const original = await readFile(snapshot.paths.configFile);
    await expect(runSetup({ ...environment, SFUD_ACCESS_PASSWORD: '' }, prompt(['2', '', '', '', 'n']))).rejects.toThrow(/비밀번호/u);
    expect(await readFile(snapshot.paths.configFile)).toEqual(original);
    const terminal = prompt([]);
    expect(await runSetup({ ...environment, LOCAL: 'false' }, terminal)).toBe(2);
    expect(terminal.requests).toEqual([]);
  }, timeout);
  it('기존 비어 있지 않은 데이터 경로에는 새 키를 생성하지 않는다', async () => {
    const { environment, snapshot } = await fixture();
    const data = path.join(snapshot.paths.directory, 'data', 'local');
    await mkdir(data, { recursive: true }); await writeFile(path.join(data, 'existing-state'), 'present');
    const terminal = prompt(['1', '', '', '', 'n', 'y']);
    expect(await runSetup(environment, terminal)).toBe(0);
    expect((await readHomeConfigurationSnapshot(environment)).secrets.SFUD_TOKEN_SECRET).toBeUndefined();
    expect(terminal.requests.some((request) => request.message.includes('새 암호화 키'))).toBe(false);
  }, timeout);
  it('저장 취소와 비밀번호 불일치는 새 설치 파일을 만들지 않는다', async () => {
    const { root, environment } = await fixture(false);
    expect(await runSetup(environment, prompt(['1', '', '', '', 'n', 'n', 'n']))).toBe(0);
    expect(await readdir(root)).toEqual([]);
    await expect(runSetup(environment, prompt(['2', '', '', '', 'n', 'valid-password-one', 'different-password']))).rejects.toThrow(/일치/u);
    expect(await readdir(root)).toEqual([]);
  }, timeout);
});

describe('설정 파일 교체와 복구', () => {
  it.each(['abc"defghijklmnop', 'abc\\defghijklmnop', 'abc#defghijklmnop', ' abcdefghijklmnop ', "a'\"`bcdefghijklmnop"])('비밀값 roundtrip 및 원문 보존: %s', async (value) => {
    const { environment, snapshot } = await fixture();
    const original = "# existing comment\nSFUD_SF_TOKEN_SECRET='preserved-legacy-secret-1234567890123456'\n";
    await writeFile(snapshot.paths.secretsFile, original);
    const loaded = await readHomeConfigurationSnapshot(environment);
    await saveHomeConfiguration(loaded, loaded.configuration, { ...loaded.secrets, SFUD_ACCESS_PASSWORD: value });
    expect((await readHomeConfigurationSnapshot(environment)).secrets.SFUD_ACCESS_PASSWORD).toBe(value);
    expect((await readFile(snapshot.paths.secretsFile, 'utf8')).startsWith(original)).toBe(true);
  }, timeout);
  it('dotenv로 표현할 수 없는 값은 쓰기 전에 거부한다', async () => {
    const { snapshot } = await fixture();
    const original = await readFile(snapshot.paths.secretsFile);
    await expect(saveHomeConfiguration(snapshot, snapshot.configuration, { SFUD_ACCESS_PASSWORD: "a'\"`#bcdefghijklmnop" })).rejects.toThrow(/손실/u);
    expect(await readFile(snapshot.paths.secretsFile)).toEqual(original);
  }, timeout);
  it('같은 내용의 다른 파일로 교체된 snapshot과 기존 잠금 파일은 거부한다', async () => {
    const { snapshot } = await fixture();
    const replaced = path.join(snapshot.paths.directory, 'replacement');
    await writeFile(replaced, snapshot.originals.config!, { mode: 0o600 });
    // Existing config ACL must remain valid on Windows; rename changes identity before preflight.
    await rename(replaced, snapshot.paths.configFile);
    await expect(saveHomeConfiguration(snapshot, snapshot.configuration, snapshot.secrets)).rejects.toThrow();
    const current = await readHomeConfigurationSnapshot({ SFUD_CONFIG_DIR: snapshot.paths.directory }).catch(() => undefined);
    if (current !== undefined) {
      await writeFile(path.join(snapshot.paths.directory, '.setup.lock'), '', { mode: 0o600 });
      await expect(saveHomeConfiguration(current, current.configuration, current.secrets)).rejects.toThrow(/진행 중/u);
    }
  }, timeout);
  it.each([1, 2])('파일 %i 교체 뒤 검증 실패시 두 원본을 복구한다', async (failureAt) => {
    const { environment, snapshot } = await fixture();
    const originals = { config: await readFile(snapshot.paths.configFile), secrets: await readFile(snapshot.paths.secretsFile) };
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let replaced = 0; let failTarget: string | undefined;
    vi.mocked(rename).mockImplementation(async (from, to) => { await actual.rename(from, to); replaced += 1; if (replaced === failureAt) failTarget = String(to); });
    vi.mocked(lstat).mockImplementation(async (target, ...args) => {
      if (String(target) === failTarget) { failTarget = undefined; throw new Error('injected post-rename failure'); }
      return actual.lstat(target, ...args);
    });
    await expect(saveHomeConfiguration(snapshot, { ...snapshot.configuration, SFUD_UI_PORT: '28001' }, { SFUD_ACCESS_PASSWORD: 'new-password-1234' })).rejects.toThrow();
    expect(await readFile(snapshot.paths.configFile)).toEqual(originals.config);
    expect(await readFile(snapshot.paths.secretsFile)).toEqual(originals.secrets);
    expect((await readHomeConfigurationSnapshot(environment)).secrets.SFUD_ACCESS_PASSWORD).toBeUndefined();
    expect(await readdir(snapshot.paths.directory)).toEqual(['config.json', 'secrets.env']);
  }, timeout);
  it('외부 파일 교체 때문에 복구가 막히면 외부 파일을 보존하고 원본 비밀 백업을 남긴다', async () => {
    const { environment, snapshot } = await fixture();
    const original = "SFUD_TOKEN_SECRET='original-key-123456789012345678901234567890'\n";
    await writeFile(snapshot.paths.secretsFile, original);
    const loaded = await readHomeConfigurationSnapshot(environment);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let inject = false;
    vi.mocked(rename).mockImplementation(async (from, to) => { await actual.rename(from, to); if (String(to) === snapshot.paths.secretsFile) inject = true; });
    vi.mocked(lstat).mockImplementation(async (target, ...args) => {
      if (inject && String(target) === snapshot.paths.secretsFile) {
        inject = false;
        const external = path.join(snapshot.paths.directory, 'external-change');
        await actual.writeFile(external, 'SFUD_ACCESS_PASSWORD=external-password-123\n', { mode: 0o600 });
        await actual.rename(external, snapshot.paths.secretsFile);
        throw new Error('external replacement after commit');
      }
      return actual.lstat(target, ...args);
    });
    await expect(saveHomeConfiguration(loaded, loaded.configuration, { ...loaded.secrets, SFUD_ACCESS_PASSWORD: 'new-password-123' })).rejects.toThrow(/원본 백업/u);
    expect(await readFile(snapshot.paths.secretsFile, 'utf8')).toContain('external-password-123');
    const backups = (await readdir(snapshot.paths.directory)).filter((name) => name.endsWith('.tmp'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(snapshot.paths.directory, backups[0]!), 'utf8')).toBe(original);
  }, timeout);
});

it('터미널 숨김 입력은 비밀번호를 echo하지 않고 정상·취소 후 raw 상태를 복구한다', async () => {
  const input = new PassThrough() as unknown as typeof process.stdin;
  const output = new PassThrough() as unknown as typeof process.stdout;
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: (raw: boolean) => { Object.assign(input, { isRaw: raw }); return input; } });
  Object.assign(output, { isTTY: true });
  let echoed = ''; output.on('data', (chunk: Buffer) => { echoed += chunk.toString(); });
  const terminal = terminalSetupPrompt(input, output);
  const pending = terminal.ask('password: ', true);
  input.emit('data', Buffer.from('secret-password-123\r'));
  expect(await pending).toBe('secret-password-123'); expect(echoed).not.toContain('secret-password-123'); expect(input.isRaw).toBe(false);
  const cancelled = terminal.ask('again: ', true);
  input.emit('data', Buffer.from('\u0003'));
  await expect(cancelled).rejects.toThrow(/취소/u); expect(input.isRaw).toBe(false);
  const unicode = terminal.ask('unicode: ', true);
  const bytes = Buffer.from('한글-password');
  input.emit('data', bytes.subarray(0, 1));
  input.emit('data', bytes.subarray(1, 4));
  input.emit('data', bytes.subarray(4));
  input.emit('data', Buffer.from('\u001b[D\u001b[A\r'));
  expect(await unicode).toBe('한글-password'); expect(input.isRaw).toBe(false);
});
