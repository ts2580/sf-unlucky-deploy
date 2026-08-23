import { spawn } from 'node:child_process';

import { SfudError } from '../core/errors.js';

export interface SfRunOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface SfClient {
  runJson(args: readonly string[], options: SfRunOptions): Promise<unknown>;
}

export class ProcessSfClient implements SfClient {
  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    const finalArgs = args.includes('--json') ? [...args] : [...args, '--json'];
    const result = await runProcess('sf', finalArgs, options);

    if (result.exitCode !== 0) {
      throw new SfudError(
        'SF_COMMAND_FAILED',
        `Salesforce CLI 명령이 실패했습니다 (${describeCommand(finalArgs)}): ${extractSfFailureMessage(result.stdout, result.stderr)}`,
      );
    }

    try {
      const parsed = JSON.parse(result.stdout) as { status?: number; message?: string };
      if (typeof parsed.status === 'number' && parsed.status !== 0) {
        throw new SfudError(
          'SF_COMMAND_FAILED',
          `Salesforce CLI가 실패 상태를 반환했습니다 (${describeCommand(finalArgs)}): ${extractSfFailureMessage(result.stdout, result.stderr)}`,
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
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        SF_USE_PROGRESS_BAR: 'false',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs ?? 35 * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(
        new SfudError('SF_COMMAND_FAILED', `Salesforce CLI를 실행할 수 없습니다: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new SfudError('SF_COMMAND_TIMEOUT', 'Salesforce CLI 명령이 제한 시간을 초과했습니다.'));
        return;
      }
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/("?(?:accessToken|refreshToken|clientSecret|sfdxAuthUrl)"?\s*[:=]\s*")([^"]+)(")/giu, '$1[REDACTED]$3')
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
      if (/(?:access|refresh)?token|clientsecret|sfdxauthurl/iu.test(key)) {
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
