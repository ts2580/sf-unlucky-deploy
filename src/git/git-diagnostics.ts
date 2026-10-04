import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git-errors.js';

interface Context { logFile?: string; operationId: string }
const context = new AsyncLocalStorage<Context>();
const pending = new Map<string, Promise<void>>();
const bridgeSecrets = new Map<string, readonly string[]>();

export function registerGitDiagnosticSecrets(nonce: string, secrets: readonly string[]): () => void {
  bridgeSecrets.set(nonce, [...secrets, nonce]);
  return () => { bridgeSecrets.delete(nonce); };
}

export async function runGitOperation<T>(logFile: string | undefined, operationId: string | undefined,
  stage: string, work: () => Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (logFile === undefined && parent === undefined) return work();
  return context.run({ ...(logFile === undefined ? parent : { logFile }),
    operationId: operationId ?? parent?.operationId ?? randomUUID() }, async () => {
    try { return await work(); }
    catch (error) {
      await logGitFailure({ stage, errorCode: error instanceof GitError ? error.code : 'GIT_PROCESS_FAILED' });
      throw error;
    }
  });
}

export function sanitizeGitStderr(value: string, secrets: readonly string[] = [], nonce?: string): string {
  let result = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
  const variants = [...secrets, ...(nonce === undefined ? [] : bridgeSecrets.get(nonce) ?? [nonce])].filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret),
    Buffer.from(secret).toString('base64')]).sort((a, b) => b.length - a.length);
  for (const secret of variants) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/(?:https?|ssh|file):\/\/[^\s"'<>]+/giu, '[URL]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/giu, '[AUTH REDACTED]')
    .replace(/\b(?:password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|nonce)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '[SECRET REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)/gu, '[REDACTED]')
    .trim().slice(0, 8192);
}

export async function logGitFailure(event: {
  stage: string; errorCode: string; exitCode?: number | null; signal?: string | null;
  spawnCode?: string; durationMs?: number; inputCount?: number; stderr?: string;
}): Promise<void> {
  const active = context.getStore();
  if (active === undefined) return;
  const line = JSON.stringify({ time: new Date().toISOString(), event: 'git.failure',
    operationId: active.operationId, ...event }) + '\n';
  try { process.stderr.write(line); } catch { /* Diagnostics must not replace the operation error. */ }
  if (active.logFile === undefined) return;
  const file = active.logFile;
  const write = (pending.get(file) ?? Promise.resolve()).then(async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const size = await stat(file).then((entry) => entry.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    // Bound disk use to the current file and one previous file.
    if (size + Buffer.byteLength(line) > 1024 * 1024) await rename(file, `${file}.1`);
    await appendFile(file, line, { mode: 0o600 });
  }).catch(() => {
    try { process.stderr.write('[GIT_LOG_WRITE_FAILED] Git 진단 로그 파일을 기록하지 못했습니다. 터미널 로그를 확인하세요.\n'); }
    catch { /* Best effort. */ }
  });
  pending.set(file, write);
  await write;
  if (pending.get(file) === write) pending.delete(file);
}
