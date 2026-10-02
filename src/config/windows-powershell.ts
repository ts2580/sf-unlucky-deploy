import { spawn } from 'node:child_process';
import path from 'node:path';

import { SfudError } from '../core/errors.js';

const TIMEOUT_MS = 10_000;
const BOOTSTRAP_KEYS = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
]);

export async function runWindowsPowerShell(script: string, variables: Readonly<Record<string, string>>): Promise<void> {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (BOOTSTRAP_KEYS.has(key.toUpperCase()) && value !== undefined) environment[key.toUpperCase()] = value;
  }
  const systemRoot = environment.SYSTEMROOT ?? 'C:\\Windows';
  environment.SYSTEMROOT = systemRoot;
  // Resolve built-in ACL cmdlets from the Windows PowerShell installation, never user modules.
  environment.PSModulePath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  Object.assign(environment, variables);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env: environment, windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(aclError(`PowerShell 시간 초과: ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timer);
      reject(aclError('PowerShell 실행 실패'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(aclError(code === null ? `PowerShell 신호 종료: ${signal ?? 'unknown'}` : `PowerShell 종료 코드: ${code}`));
    });
  });
}

function aclError(reason: string): SfudError {
  // Child output and paths can contain private configuration values; report only the failure category.
  return new SfudError('CONFIGURATION_ERROR', `Windows 사용자 ACL을 안전하게 확인하거나 설정하지 못했습니다. (${reason})`);
}
