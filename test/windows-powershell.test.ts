import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWindowsPowerShell } from '../src/config/windows-powershell.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function childProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe('Windows ACL PowerShell 실행 경계', () => {
  it('시스템 부트스트랩만 상속하고 스크립트와 메타문자 경로를 셸·stdin 없이 전달한다', async () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('TEMP', 'C:\\Temp');
    vi.stubEnv('USERPROFILE', 'C:\\Users\\runner');
    vi.stubEnv('PSModulePath', 'C:\\untrusted-modules');
    vi.stubEnv('NODE_OPTIONS', '--require=private-value');
    vi.stubEnv('SFUD_TOKEN_SECRET', 'private-value');
    const child = childProcess();
    const script = '$target = $env:SFUD_ACL_PATH\nWrite-Output "한글 & quotes"\nexit 0';
    const target = 'C:\\R&D [ACL]\\%PATH% !name!\\config.json';
    const operation = runWindowsPowerShell(script, { SFUD_ACL_PATH: target });
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(args?.at(-2)).toBe('-EncodedCommand');
    expect(Buffer.from(args!.at(-1)!, 'base64').toString('utf16le')).toBe(script);
    expect(options).toMatchObject({ shell: false, stdio: 'ignore', windowsHide: true,
      env: { SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp', USERPROFILE: 'C:\\Users\\runner', SFUD_ACL_PATH: target } });
    expect(options?.env?.PSModulePath).toBe(path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
    for (const key of Object.keys(options?.env ?? {})) {
      expect(['PATH', 'NODE_OPTIONS', 'SFUD_TOKEN_SECRET']).not.toContain(key.toUpperCase());
    }
    child.emit('close', 0, null);
    await operation;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('ACL 거부 종료 코드를 유지하고 경로 및 비밀값을 오류에 노출하지 않는다', async () => {
    const child = childProcess();
    const operation = runWindowsPowerShell('exit 24', { SFUD_ACL_PATH: 'private-value' });
    child.emit('close', 24, null);
    await expect(operation).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', message: expect.stringContaining('종료 코드: 24') });
    await expect(operation).rejects.not.toThrow('private-value');
  });

  it('프로세스 시작 실패의 원문에 포함된 비밀값을 숨긴다', async () => {
    const child = childProcess();
    const operation = runWindowsPowerShell('exit 0', {});
    child.emit('error', new Error('spawn private-value ENOENT'));
    await expect(operation).rejects.toThrow('PowerShell 실행 실패');
    await expect(operation).rejects.not.toThrow('private-value');
  });

  it('응답 없는 프로세스를 제한 시간에 종료하고 타임아웃으로 보고한다', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const operation = runWindowsPowerShell('exit 0', {});
    const rejected = expect(operation).rejects.toThrow('PowerShell 시간 초과: 10000ms');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
  });
});
