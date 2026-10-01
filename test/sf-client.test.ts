import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  extractSfFailureMessage,
  isDefiniteSalesforceAuthFailure,
  isAmbiguousSalesforceFailure,
  ProcessSfClient,
  redactSensitiveText,
  sanitizeSfOutput,
  sfProcessCommand,
} from '../src/salesforce/sf-client.js';
import { SfudError } from '../src/core/errors.js';

describe('Salesforce CLI output sanitization', () => {
  it('중첩된 인증 필드와 auth URL을 제거한다', () => {
    expect(
      sanitizeSfOutput({
        status: 0,
        result: {
          accessToken: 'secret-token',
          nested: { refreshToken: 'refresh-secret' },
          sfdxAuthUrl: 'force://client:secret@example.com',
          id: '0Af-safe',
        },
      }),
    ).toEqual({
      status: 0,
      result: {
        accessToken: '[REDACTED]',
        nested: { refreshToken: '[REDACTED]' },
        sfdxAuthUrl: '[REDACTED]',
        id: '0Af-safe',
      },
    });
  });

  it('문자열 안의 SFDX auth URL을 제거한다', () => {
    expect(redactSensitiveText('failed: force://client:secret@example.com')).toBe(
      'failed: force://[REDACTED]',
    );
  });

  it('Git 제공자 token과 OAuth callback query 및 Basic/Bearer credential을 마스킹한다', () => {
    for (const value of [
      'Authorization: Bearer sensitive-secret', 'Authorization: Basic sensitive-secret',
      '{"access_token":"sensitive-secret","refresh_token":"sensitive-secret","client_secret":"sensitive-secret"}',
      'https://github.com/a/b?code=sensitive-secret&state=sensitive-secret',
      'https://oauth2:sensitive-secret@gitlab.com/group/project.git',
    ]) expect(redactSensitiveText(value)).not.toContain('sensitive-secret');
    expect(sanitizeSfOutput({ client_secret: 'secret', authorization: 'Basic secret' }))
      .toEqual({ client_secret: '[REDACTED]', authorization: '[REDACTED]' });
  });

  it('Metadata API component failure의 실제 원인을 추출한다', () => {
    const stdout = JSON.stringify({
      status: 1,
      result: {
        status: 'Failed',
        details: {
          componentFailures: [{ problem: 'No package.xml found', problemType: 'Error' }],
        },
      },
    });

    expect(extractSfFailureMessage(stdout, '')).toBe('Failed | No package.xml found');
  });

  it('제한 시간과 전송 단절을 외부 상태가 불명확한 오류로 분류한다', () => {
    expect(isAmbiguousSalesforceFailure(
      new SfudError('SF_COMMAND_TIMEOUT', 'Salesforce CLI 명령이 제한 시간을 초과했습니다.'),
    )).toBe(true);
    expect(isAmbiguousSalesforceFailure(new Error('request aborted: ECONNRESET'))).toBe(true);
    expect(isAmbiguousSalesforceFailure(
      new SfudError('SF_COMMAND_FAILED', 'Apex 테스트가 실패했습니다.'),
    )).toBe(false);
  });

  it('구조화된 invalid_grant만 재인증 필요로 분류하고 CLI 오류 비밀값을 숨긴다', async () => {
    const fixture = await createNodeScript(`process.stdout.write(JSON.stringify({ status: 1, name: 'refreshTokenAuthError', cause: 'invalid_grant: fixture revoked force://client:secret@my.salesforce.com' })); process.exitCode = 1;`);
    try {
      let captured: unknown;
      try { await new ProcessSfClient(process.execPath).runJson([fixture.script], { cwd: fixture.root }); }
      catch (error) { captured = error; }
      expect(isDefiniteSalesforceAuthFailure(captured)).toBe(true);
      expect(captured).toMatchObject({ causeCode: 'invalid_grant' });
      expect(captured instanceof Error ? captured.message : '').not.toContain('client:secret');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it('refreshTokenAuthError의 일시 cause는 메시지에 invalid_grant가 있어도 재인증으로 오판하지 않는다', async () => {
    const fixture = await createNodeScript(`process.stdout.write(JSON.stringify({ status: 1, name: 'refreshTokenAuthError', cause: 'ECONNRESET: transient socket error mentioning invalid_grant in diagnostic text' })); process.exitCode = 1;`);
    try {
      let captured: unknown;
      try { await new ProcessSfClient(process.execPath).runJson([fixture.script], { cwd: fixture.root }); }
      catch (error) { captured = error; }
      expect(isDefiniteSalesforceAuthFailure(captured)).toBe(false);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

describe('Salesforce CLI process limits', () => {
  it('Linux와 커스텀 실행 파일은 직접 실행한다', () => {
    expect(sfProcessCommand('sf', ['org', 'list', '--json'], 'linux')).toEqual({
      executable: 'sf', args: ['org', 'list', '--json'],
    });
    expect(sfProcessCommand('C:\\tools\\sf.exe', ['org', 'list'], 'win32')).toEqual({
      executable: 'C:\\tools\\sf.exe', args: ['org', 'list'],
    });
  });

  it('Windows npm 진입점을 셸 없이 실행하여 메타문자 인자를 그대로 전달한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-shim-'));
    try {
      const bin = path.join(root, 'R&D (CLI)');
      const entry = path.join(bin, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(path.join(bin, 'sf.cmd'), '@echo off\r\nexit /b 99');
      await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const args = ['--source-dir', 'C:\\R&D\\force-app', '&echo injected>sentinel', '|echo bad',
        '%PATH%', '!PATH!', '^', '(x)', 'with spaces', '"quoted"', 'trailing\\', ''];
      const command = sfProcessCommand('sf', args, 'win32', { Path: `.;"${bin}"` });
      expect(command).toEqual({ executable: process.execPath, args: [entry, ...args] });
      const result = await promisify(execFile)(command.executable, [...command.args], { cwd: root, shell: false });
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(sfProcessCommand(path.join(bin, 'sf.cmd'), args, 'win32', {})).toEqual(command);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('Windows installer와 사용자 업데이트의 bundled Node를 찾는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-installer-'));
    try {
      const bin = path.join(root, 'Program Files', 'sf', 'bin');
      const clientBin = path.resolve(bin, '..', 'client', 'bin');
      const localAppData = path.join(root, 'Local');
      const updateBin = path.join(localAppData, 'sf', 'client', 'bin');
      await mkdir(bin, { recursive: true });
      await mkdir(clientBin, { recursive: true });
      await writeFile(path.join(bin, 'sf.cmd'), 'installer shim');
      await writeFile(path.join(clientBin, 'node.exe'), 'bundled node');
      await writeFile(path.join(clientBin, 'run'), 'entrypoint');
      expect(sfProcessCommand('sf', ['org', 'list'], 'win32', { PATH: bin })).toEqual({
        executable: path.join(clientBin, 'node.exe'), args: [path.join(clientBin, 'run'), 'org', 'list'],
      });
      await mkdir(updateBin, { recursive: true });
      await writeFile(path.join(updateBin, 'node.exe'), 'updated node');
      await writeFile(path.join(updateBin, 'run.js'), 'updated entrypoint');
      expect(sfProcessCommand('sf', [], 'win32', { PATH: bin, LOCALAPPDATA: localAppData })).toEqual({
        executable: path.join(updateBin, 'node.exe'), args: [path.join(updateBin, 'run.js')],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('알 수 없는 Windows shim이나 누락된 설치는 셸 fallback 없이 시작 전 실패한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-unknown-shim-'));
    try {
      await writeFile(path.join(root, 'sf.cmd'), 'echo unsafe');
      for (const environment of [{ PATH: root }, { PATH: '.;relative' }]) {
        expect(() => sfProcessCommand('sf', [], 'win32', environment))
          .toThrow('Salesforce CLI의 Node 진입점을 찾을 수 없습니다');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('Salesforce 자식 프로세스에 Git 토큰·키 파일·credential bridge 환경을 전달하지 않는다', async () => {
    const keys = ['SFUD_GIT_TOKEN_SECRET', 'SFUD_GIT_TOKEN_KEY_FILE', 'SFUD_GITHUB_CLIENT_SECRET_FILE', 'GH_TOKEN', 'GIT_ASKPASS', 'SFUD_GIT_BRIDGE_NONCE'];
    for (const key of keys) vi.stubEnv(key, 'secret-fixture');
    const fixture = await createNodeScript(`process.stdout.write(JSON.stringify({ status: 0, result: ${JSON.stringify(keys)}.some(key => process.env[key] !== undefined) }));`);
    try {
      expect(await new ProcessSfClient(process.execPath).runJson([fixture.script], { cwd: fixture.root }))
        .toEqual({ status: 0, result: false });
    } finally { vi.unstubAllEnvs(); await rm(fixture.root, { recursive: true, force: true }); }
  });

  it('완전한 JSON 출력이 제한을 넘으면 정해진 오류로 종료한다', async () => {
    const fixture = await createNodeScript(
      `process.stdout.write(JSON.stringify({ status: 0, result: { data: 'x'.repeat(4096) } }));`,
    );
    try {
      const client = new ProcessSfClient(process.execPath);
      await expect(client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 1_000,
        maxOutputBytes: 128,
      })).rejects.toMatchObject({ code: 'SF_OUTPUT_TOO_LARGE' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('SIGTERM을 무시하는 child를 grace period 뒤 강제 종료한다', async () => {
    const fixture = await createNodeScript(
      `process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);`,
    );
    try {
      const client = new ProcessSfClient(process.execPath);
      const startedAt = Date.now();
      await expect(client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 30,
        terminationGraceMs: 30,
      })).rejects.toMatchObject({ code: 'SF_COMMAND_TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('AbortSignal이 전달되면 실행 중인 child를 종료한다', async () => {
    const fixture = await createNodeScript(`setInterval(() => undefined, 1_000);`);
    try {
      const controller = new AbortController();
      const client = new ProcessSfClient(process.execPath);
      const result = client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 1_000,
        terminationGraceMs: 30,
        signal: controller.signal,
      });
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: 'SF_COMMAND_ABORTED' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createNodeScript(contents: string): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-process-'));
  const script = path.join(root, 'fixture.mjs');
  await writeFile(script, contents, { encoding: 'utf8', mode: 0o600 });
  return { root, script };
}
