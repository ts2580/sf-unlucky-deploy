import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor, type DoctorDependencies } from '../src/config/doctor.js';
import { initializeHomeConfiguration } from '../src/config/user-config.js';
import { runSetup } from '../src/config/setup.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tools: DoctorDependencies = { version: async (command) => command === 'git' ? 'git version 2.43.0' : '@salesforce/cli/2.110.0 linux-x64 node-v22.19.0', oauthPort: async () => 1717 };
const timeout = process.platform === 'win32' ? 180_000 : 20_000;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-doctor-')); directories.push(root);
  const environment = { SFUD_CONFIG_DIR: path.join(root, 'home'), SFUD_DATA_DIR: path.join(root, 'data') };
  return { root, environment };
}
async function database(directory: string, mode: string) {
  await mkdir(directory);
  const db = await new Promise<sqlite3.Database>((resolve, reject) => { const opened = new sqlite3.Database(path.join(directory, 'sfud.db'), (error) => error === null ? resolve(opened) : reject(error)); });
  await new Promise<void>((resolve, reject) => db.exec(`CREATE TABLE runtime_mode(id INTEGER, mode TEXT); INSERT INTO runtime_mode VALUES (1, '${mode}');`, (error) => error === null ? resolve() : reject(error)));
  await new Promise<void>((resolve) => db.close(() => resolve()));
}

describe('doctor 읽기 전용 진단', () => {
  it('없는 홈·데이터 경로는 생성하지 않고 URL은 기본 점검하지 않는다', async () => {
    const { root, environment } = await fixture();
    const reach = vi.fn(async () => true);
    const report = await runDoctor({}, environment, { ...tools, reach }, root);
    expect(await readdir(root)).toEqual([]);
    expect(report.exitCode).toBe(0); expect(report.connection?.reachability).toBe('not_checked'); expect(reach).not.toHaveBeenCalled();
    expect(report.configuration?.file).toBe(path.join(root, 'home', 'config.json'));
  }, timeout);
  it('부족한 companion 파일을 생성하지 않고 비밀값·빈 환경변수 우선 검사를 수행한다', async () => {
    const { root, environment } = await fixture();
    const paths = await initializeHomeConfiguration(environment);
    await rm(paths.secretsFile);
    const before = await readFile(paths.configFile);
    await runDoctor({}, environment, tools, root);
    expect(await readdir(paths.directory)).toEqual(['config.json']); expect(await readFile(paths.configFile)).toEqual(before);
    const secret = 'never-print-this-fixture-password';
    await writeFile(paths.secretsFile, `SFUD_ACCESS_PASSWORD='${secret}'\n`, { mode: 0o600 });
    const report = await runDoctor({}, { ...environment, SFUD_ACCESS_PASSWORD: '' }, tools, root);
    expect(report.exitCode).toBe(1); expect(JSON.stringify(report)).not.toContain(secret);
  }, timeout);
  it('기존 DB 모드를 immutable로 읽고 모드 불일치에도 DB와 WAL/shm을 변경하지 않는다', async () => {
    const { root, environment } = await fixture();
    await database(environment.SFUD_DATA_DIR, 'multiuser');
    const before = await readFile(path.join(environment.SFUD_DATA_DIR, 'sfud.db'));
    const report = await runDoctor({}, { ...environment, LOCAL: 'true' }, tools, root);
    expect(report.checks.find((check) => check.id === 'database-mode')?.status).toBe('fail');
    expect(await readFile(path.join(environment.SFUD_DATA_DIR, 'sfud.db'))).toEqual(before);
    expect(await readdir(environment.SFUD_DATA_DIR)).toEqual(['sfud.db']);
  }, timeout);
  it('불완전한 WAL을 읽거나 쓰지 않고 DB 모드 확정을 보류하며 setup은 차단한다', async () => {
    const { root, environment } = await fixture();
    await database(environment.SFUD_DATA_DIR, 'local');
    const wal = path.join(environment.SFUD_DATA_DIR, 'sfud.db-wal'); await writeFile(wal, 'uncheckpointed-fixture');
    const before = await readFile(wal);
    const report = await runDoctor({}, { ...environment, LOCAL: 'true' }, tools, root);
    expect(report.checks.find((check) => check.id === 'database-mode')?.status).toBe('warn');
    expect(await readFile(wal)).toEqual(before); expect(await readdir(environment.SFUD_DATA_DIR)).toEqual(['sfud.db', 'sfud.db-wal']);
    const answers = ['1', '', '', '', 'n'];
    await expect(runSetup({ ...environment, LOCAL: 'true' }, { interactive: true, write: () => undefined, ask: async () => answers.shift()! })).rejects.toThrow(/DB/u);
    expect(await readdir(root)).toEqual(['data']);
  }, timeout);
  it('--check-url에서만 HTTP 읽기를 수행하며 서버 도달과 브라우저 성공을 구분한다', async () => {
    const { root, environment } = await fixture();
    const reach = vi.fn(async () => true);
    const report = await runDoctor({ checkUrl: true }, { ...environment, LOCAL: 'true' }, { ...tools, reach }, root);
    expect(reach).toHaveBeenCalledWith('http://127.0.0.1:27546');
    expect(report.connection?.reachability).toBe('reachable_from_server'); expect(report.connection?.message).toContain('외부 브라우저');
    expect(report.oauth?.callback).toBe('http://localhost:1717/OauthRedirect');
    const wildcard = await runDoctor({ checkUrl: true }, { ...environment, LOCAL: 'true', SFUD_UI_HOST: '0.0.0.0', SFUD_ACCESS_PASSWORD: 'valid-password-123' }, { ...tools, reach }, root);
    expect(wildcard.connection?.reachability).toBe('no_concrete_url'); expect(reach).toHaveBeenCalledTimes(1);
  }, timeout);
  it.each([
    { SFUD_TRUSTED_PROXIES: 'not-an-ip', SFUD_PUBLIC_ORIGIN: 'https://example.com' },
    { SFUD_TRUSTED_PROXIES: '127.0.0.1' },
    { SFUD_PUBLIC_ORIGIN: 'https://private:secret@example.com/path' },
    { SFUD_TOKEN_SECRET: '' },
    { SFUD_TOKEN_SECRET: 'x'.repeat(31) },
  ])('잘못된 프록시·URL·키를 값 원문 없이 진단한다: %j', async (overrides) => {
    const { root, environment } = await fixture();
    const report = await runDoctor({}, { ...environment, ...overrides }, tools, root);
    expect(report.exitCode).toBe(1); expect(JSON.stringify(report)).not.toContain('private:secret');
  }, timeout);
  it('도구 오류 원문 없이 종료 코드와 OAuth 로컬 프로젝트 포트를 안내한다', async () => {
    const { root, environment } = await fixture();
    const secret = 'private-value-never-print';
    const report = await runDoctor({}, environment, { version: async () => { throw new Error(secret); } }, root);
    expect(report.exitCode).toBe(1); expect(JSON.stringify(report)).not.toContain(secret);
    await writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({ oauthLocalPort: 1818 }));
    const callback = await runDoctor({}, { ...environment, LOCAL: 'true' }, { version: tools.version! }, root);
    expect(callback.oauth?.port).toBe(1818);
  }, timeout);
});
