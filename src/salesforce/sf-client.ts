import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

import { SfudError } from '../core/errors.js';

export interface SfRunOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
}

export interface SfClient {
  runJson(args: readonly string[], options: SfRunOptions): Promise<unknown>;
}

/** 프로세스가 시작되지 않았음을 확인한 오류에만 사용한다. */
export class SfCommandNotStartedError extends SfudError {}

export class SfCommandFailedError extends SfudError {
  public constructor(message: string, public readonly cliErrorCode?: string, public readonly cliErrorName?: string,
    public readonly causeCode?: string) {
    super('SF_COMMAND_FAILED', message);
    this.name = 'SfCommandFailedError';
  }
}

export class ProcessSfClient implements SfClient {
  public constructor(private readonly command = 'sf') {}

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    const finalArgs = args.includes('--json') ? [...args] : [...args, '--json'];
    const result = await runProcess(this.command, finalArgs, options);

    if (result.exitCode !== 0) {
      throw commandFailure(
        `Salesforce CLI 명령이 실패했습니다 (${describeCommand(finalArgs)}): ${extractSfFailureMessage(result.stdout, result.stderr)}`,
        result.stdout,
      );
    }

    try {
      const parsed = JSON.parse(result.stdout) as { status?: number; message?: string };
      if (typeof parsed.status === 'number' && parsed.status !== 0) {
        throw commandFailure(
          `Salesforce CLI가 실패 상태를 반환했습니다 (${describeCommand(finalArgs)}): ${extractSfFailureMessage(result.stdout, result.stderr)}`,
          result.stdout,
        );
      }
      return parsed;
    } catch (error) {
      if (error instanceof SfudError) {
        throw error;
      }
      throw new SfudError(
        'SF_RESPONSE_INVALID',
        `Salesforce CLI JSON 응답을 해석할 수 없습니다 (${describeCommand(finalArgs)}).`,
        { cause: error },
      );
    }
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: SfRunOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted === true) {
    throw new SfCommandNotStartedError('SF_COMMAND_ABORTED', 'Salesforce CLI 명령이 시작 전에 취소되었습니다.');
  }
  return await new Promise((resolve, reject) => {
    const processCommand = sfProcessCommand(command, args);
    const child = spawn(processCommand.executable, processCommand.args, {
      cwd: options.cwd,
      env: {
        ...salesforceEnvironment(options.environment ?? process.env),
        SF_USE_PROGRESS_BAR: 'false',
      },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => { /* CLI가 입력을 읽기 전에 종료할 수 있다. close 이벤트에서 실패 처리한다. */ });
      child.stdin?.end(options.stdin);
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
    const terminationGraceMs = options.terminationGraceMs ?? 2_000;
    let outputBytes = 0;
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    let requestedError: SfudError | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      requestTermination(new SfudError('SF_COMMAND_TIMEOUT', 'Salesforce CLI 명령이 제한 시간을 초과했습니다.'));
    }, options.timeoutMs ?? 35 * 60 * 1000);
    timeout.unref();
    const abort = () => {
      requestTermination(new SfudError('SF_COMMAND_ABORTED', 'Salesforce CLI 명령이 취소되었습니다.'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const collect = (target: Buffer[], chunk: Buffer) => {
      if (requestedError !== undefined) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        requestTermination(new SfudError(
          'SF_OUTPUT_TOO_LARGE',
          `Salesforce CLI JSON 출력이 ${maxOutputBytes}바이트 제한을 초과했습니다.`,
        ));
        return;
      }
      target.push(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      finish(() => reject(
        new (spawned ? SfudError : SfCommandNotStartedError)('SF_COMMAND_FAILED', `Salesforce CLI를 실행할 수 없습니다: ${error.message}`, {
          cause: error,
        }),
      ));
    });
    child.on('close', (exitCode) => {
      finish(() => {
        if (requestedError !== undefined) {
          reject(requestedError);
          return;
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });

    function requestTermination(error: SfudError): void {
      if (requestedError !== undefined || settled) return;
      requestedError = error;
      killProcessTree(child.pid, 'SIGTERM', child);
      forceKillTimer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGKILL', child);
      }, terminationGraceMs);
      forceKillTimer.unref();
    }

    function finish(operation: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
      operation();
    }
  });
}

/**
 * Never execute a Windows batch shim: cmd reinterprets even an argv array.
 * Resolve the Node entrypoint of npm/oclif installations without evaluating it.
 */
export function sfProcessCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): {
  executable: string;
  args: readonly string[];
} {
  if (platform !== 'win32' || (command !== 'sf' && !/\.(?:cmd|bat)$/iu.test(command))) {
    return { executable: command, args };
  }
  const searchPath = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  // Do not search the project cwd (or relative PATH entries) for executables.
  const directories = path.isAbsolute(command) ? [path.dirname(command)]
    : searchPath.split(';').map((entry) => entry.replace(/^"(.*)"$/u, '$1')).filter((entry) => path.isAbsolute(entry));
  for (const directory of directories) {
    if (command === 'sf' && isFile(path.join(directory, 'sf.exe'))) {
      return { executable: path.join(directory, 'sf.exe'), args };
    }
    const shim = path.isAbsolute(command) ? command : path.join(directory, command === 'sf' ? 'sf.cmd' : command);
    if (!isFile(shim)) continue;
    const npmEntry = path.join(directory, 'node_modules', '@salesforce', 'cli', 'bin', 'run.js');
    if (isFile(npmEntry)) {
      const node = path.join(directory, 'node.exe');
      return { executable: isFile(node) ? node : process.execPath, args: [npmEntry, ...args] };
    }
    const localAppData = Object.entries(environment).find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1];
    const installerBins = [
      ...(localAppData !== undefined && path.isAbsolute(localAppData)
        ? [path.join(localAppData, 'sf', 'client', 'bin')] : []),
      path.resolve(directory, '..', 'client', 'bin'),
      directory,
    ];
    for (const bin of installerBins) {
      const node = path.join(bin, 'node.exe');
      const entry = [path.join(bin, 'run'), path.join(bin, 'run.js')].find(isFile);
      if (isFile(node) && entry !== undefined) return { executable: node, args: [entry, ...args] };
    }
    // An unknown shim must not fall back to cmd or a different PATH installation.
    break;
  }
  throw new SfCommandNotStartedError('SF_COMMAND_FAILED',
    'Salesforce CLI의 Node 진입점을 찾을 수 없습니다. PATH의 공식 sf 설치(npm 또는 Windows 설치 프로그램)를 확인하세요.');
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  child: ReturnType<typeof spawn>,
): void {
  try {
    if (pid !== undefined && process.platform !== 'win32') {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 이미 종료된 프로세스는 추가 조치가 필요 없다.
    }
  }
}

function salesforceEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(?:SFUD_|GIT_|GH_TOKEN$|GITHUB_TOKEN$|GLAB_TOKEN$|GITLAB_TOKEN$|BITBUCKET_(?:TOKEN|CLIENT_SECRET)$)/iu.test(key)));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier|sfdxAuthUrl)(?:["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/giu,
      (_match, prefix: string, secret: string) => `${prefix}${secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/giu, '$1 [REDACTED]')
    .replace(/([?&](?:code|state|access_token|refresh_token|client_secret)=)[^&#\s"']*/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/giu, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,})/gu, '[REDACTED]')
    .replace(/force:\/\/[^\s"']+/giu, 'force://[REDACTED]')
    .trim();
}

export function sanitizeSfOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeSfOutput);
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(?:access|refresh)?token|client[_-]?secret|code[_-]?verifier|authorization|sfdxauthurl/iu.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeSfOutput(entry);
      }
    }
    return sanitized;
  }
  return typeof value === 'string' ? redactSensitiveText(value) : value;
}

function describeCommand(args: readonly string[]): string {
  return `sf ${args.filter((argument) => argument !== '--json').slice(0, 4).join(' ')}`;
}

export function extractSfFailureMessage(stdout: string, stderr: string): string {
  const messages: string[] = [];
  try {
    collectFailureMessages(JSON.parse(stdout) as unknown, messages);
  } catch {
    messages.push(stdout);
  }

  const details = [...messages, stderr]
    .map(redactSensitiveText)
    .filter((value) => value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
  return details.join(' | ') || '상세 메시지 없음';
}

function commandFailure(message: string, stdout: string): SfCommandFailedError {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout) as unknown; } catch { return new SfCommandFailedError(message); }
  const root = asRecord(parsed);
  const error = asRecord(root.error);
  const rootCause = asRecord(root.cause);
  const cause = asRecord(error.cause ?? root.cause);
  const rawCause = error.cause ?? root.cause;
  const causeCode = authFailureCode(cause.errorCode, cause.code, cause.error, cause.name,
    rootCause.errorCode, rootCause.code, rootCause.error, rootCause.name)
    ?? (typeof rawCause === 'string' ? serializedCauseCode(rawCause) : undefined);
  return new SfCommandFailedError(message,
    authFailureCode(error.errorCode, error.code, error.error, root.errorCode, root.code,
      typeof root.error === 'string' ? root.error : undefined),
    authFailureCode(error.name, root.name), causeCode);
}

function serializedCauseCode(value: string): string | undefined {
  // Salesforce CLI serializes inspect(error) in `cause`; accept only a leading
  // structured code token, never keywords found in an arbitrary message.
  return /^(?:Error:\s*)?(invalid_grant)(?::|\s|$)/u.exec(value)?.[1];
}

function authFailureCode(...values: unknown[]): 'invalid_grant' | undefined {
  return values.some((value) => value === 'invalid_grant') ? 'invalid_grant' : undefined;
}

export function isDefiniteSalesforceAuthFailure(error: unknown): boolean {
  if (!(error instanceof SfCommandFailedError)) return false;
  return [error.cliErrorCode, error.cliErrorName, error.causeCode]
    .some((value) => value === 'invalid_grant');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isAmbiguousSalesforceFailure(error: unknown): boolean {
  if (error instanceof SfudError && error.code === 'SF_COMMAND_TIMEOUT') return true;
  if (!(error instanceof Error)) return false;
  return /(?:ETIMEDOUT|ECONNRESET|ECONNABORTED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|connection (?:was )?(?:reset|closed|lost)|request (?:timed out|aborted))/iu
    .test(error.message);
}

function collectFailureMessages(value: unknown, messages: string[], key = ''): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFailureMessages(entry, messages, key);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      collectFailureMessages(child, messages, childKey);
    }
    return;
  }

  if (
    typeof value === 'string' &&
    /^(?:message|name|problem|errorMessage|status)$/iu.test(key) &&
    value.length > 0 &&
    value !== 'Succeeded'
  ) {
    messages.push(value);
  }
}
