import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGitDiagnosticSecrets, runGitOperation, sanitizeGitStderr } from '../src/git/git-diagnostics.js';
import { runIsolatedGit } from '../src/git/git-process.js';
import { GitError } from '../src/git/git-errors.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-diagnostics-'));
  roots.push(root);
  const gitDirectory = path.join(root, 'repository.git');
  await runIsolatedGit(['init', '--bare', gitDirectory], { cwd: root });
  return { root, gitDirectory, logFile: path.join(root, 'logs', 'git-diagnostics.jsonl') };
}

describe('Git failure diagnostics', () => {
  it('실제 Git 실패의 작업 ID, 단계, 종료 코드와 마스킹된 stderr를 파일/터미널에 남긴다', async () => {
    const f = await fixture();
    const terminal = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const secret = 'opaque-personal-token-fixture';
    const nonce = 'a'.repeat(64);
    const forget = registerGitDiagnosticSecrets(nonce, [secret]);
    try {
      await expect(runGitOperation(f.logFile, 'import-fixture', 'import', () =>
        runIsolatedGit(['cat-file', '-t', secret], { cwd: f.root, gitDirectory: f.gitDirectory,
          bridgeEnvironment: { SFUD_GIT_BRIDGE_PORT: '1', SFUD_GIT_BRIDGE_NONCE: nonce } })))
        .rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED', message: 'Git 작업을 완료하지 못했습니다.' });
      const raw = await readFile(f.logFile, 'utf8');
      expect(raw).not.toContain(secret); expect(raw).not.toContain(nonce);
      const events = raw.trim().split('\n').map((line) => JSON.parse(line));
      expect(events[0]).toMatchObject({ operationId: 'import-fixture', stage: 'cat-file', errorCode: 'GIT_PROCESS_FAILED', stderr: expect.stringContaining('[REDACTED]') });
      expect(events[0].exitCode).not.toBe(0);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(events[1]).toMatchObject({ operationId: 'import-fixture', stage: 'import' });
      expect(terminal.mock.calls.map(([line]) => line).join('')).toBe(raw);
    } finally { forget(); }
  });

  it('fetch-lazy의 입력 개수는 기록하지만 SHA 목록이나 실행 인자는 노출하지 않는다', async () => {
    const f = await fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ids = ['a'.repeat(40), 'b'.repeat(40)];
    // Invalid option fails locally, without contacting any host.
    await expect(runGitOperation(f.logFile, 'lazy-fixture', 'import', () => runIsolatedGit(
      ['fetch', '--sfud-invalid-option', '--stdin'], { cwd: f.root, gitDirectory: f.gitDirectory,
        input: Buffer.from(ids.join('\n') + '\n') }))).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
    const raw = await readFile(f.logFile, 'utf8');
    expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({ stage: 'fetch-lazy', inputCount: 2 });
    for (const id of ids) expect(raw).not.toContain(id);
  });

  it('인증 헤더, URL, opaque/인코딩된 토큰과 제어 문자를 제거한다', () => {
    const secret = 'opaque+/value';
    const raw = `fatal: bad revision ${'a'.repeat(40)}\nhttps://user:pass@private.example/repo?token=abc\n` +
      `Authorization: Basic dXNlcjpwYXNz\npassword=hidden\nglpat-fixtureToken\n` +
      `${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString('base64')}\x1b[31m\x00` +
      ` opaque\x1b[31m+/value {"token":"json-secret"}`;
    const result = sanitizeGitStderr(raw, [secret]);
    expect(result).toContain(`bad revision ${'a'.repeat(40)}`);
    for (const value of ['private.example', 'user:pass', 'dXNlcjpwYXNz', 'hidden', 'glpat-fixtureToken', secret,
      encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'json-secret', '\x1b', '\x00']) expect(result).not.toContain(value);
    expect(sanitizeGitStderr('x'.repeat(20000))).toHaveLength(8192);
  });

  it('병렬 작업과 중첩 단계의 ID가 섞이지 않는다', async () => {
    const f = await fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await Promise.allSettled(['one', 'two'].map((id) => runGitOperation(f.logFile, id, 'import', () =>
      runGitOperation(f.logFile, undefined, 'fetch', async () => { await Promise.resolve(); throw new GitError('INVALID_REF'); }))));
    const events = (await readFile(f.logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    for (const id of ['one', 'two']) expect(events.filter((event) => event.operationId === id).map((event) => event.stage)).toEqual(['fetch', 'import']);
  });

  it('파일 기록 실패가 원래 Git 오류를 덮어쓰지 않는다', async () => {
    const f = await fixture();
    const terminal = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await mkdir(f.logFile, { recursive: true });
    const original = new GitError('INVALID_REF');
    await expect(runGitOperation(f.logFile, 'write-failed', 'import', async () => { throw original; })).rejects.toBe(original);
    expect(terminal.mock.calls.map(([line]) => line).join('')).toContain('GIT_LOG_WRITE_FAILED');
  });

  it('1 MiB를 넘으면 이전 로그 한 개를 보관하고 새 파일에 기록한다', async () => {
    const f = await fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await mkdir(path.dirname(f.logFile));
    const previous = 'x'.repeat(1024 * 1024);
    await writeFile(f.logFile, previous);
    await writeFile(`${f.logFile}.1`, 'older');
    await expect(runGitOperation(f.logFile, 'rotated', 'import', async () => { throw new GitError('INVALID_REF'); })).rejects.toThrow();
    expect(await readFile(`${f.logFile}.1`, 'utf8')).toBe(previous);
    expect(JSON.parse(await readFile(f.logFile, 'utf8')).operationId).toBe('rotated');
  });

  it('Git 실행 파일이 없으면 ENOENT를 기록한다', async () => {
    const f = await fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('PATH', f.root); vi.stubEnv('Path', f.root);
    await expect(runGitOperation(f.logFile, 'missing-git', 'import', () =>
      runIsolatedGit(['cat-file', '-t', 'a'.repeat(40)], { cwd: f.root, gitDirectory: f.gitDirectory })))
      .rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
    const event = JSON.parse((await readFile(f.logFile, 'utf8')).split('\n')[0]!);
    expect(event).toMatchObject({ spawnCode: 'ENOENT', stage: 'cat-file' });
  });
});
