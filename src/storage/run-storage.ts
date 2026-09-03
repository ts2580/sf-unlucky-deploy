import { chmod, lstat, mkdir, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import { SfudError } from '../core/errors.js';

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;

export interface RunStoragePolicy {
  retentionMs: number;
  maxBytes: number;
  minFreeBytes: number;
}

export interface RunStorageCleanupResult {
  removedDirectories: number;
  retainedBytes: number;
}

export function runStoragePolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): RunStoragePolicy {
  return {
    retentionMs: positiveNumber(environment.SFUD_RUN_RETENTION_HOURS, 168) * 60 * 60 * 1_000,
    maxBytes: positiveNumber(environment.SFUD_RUN_MAX_BYTES, DEFAULT_MAX_BYTES),
    minFreeBytes: positiveNumber(environment.SFUD_RUN_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES),
  };
}

export async function prepareRunStorage(
  runsDirectory: string,
  policy: RunStoragePolicy = runStoragePolicyFromEnvironment(),
  now: () => number = Date.now,
): Promise<RunStorageCleanupResult> {
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await chmod(runsDirectory, 0o700);
  const root = await realpath(runsDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SfudError('FILESYSTEM_ERROR', 'run 저장소는 실제 디렉터리여야 합니다.');
  }

  const candidates: Array<{ path: string; modifiedAt: number; bytes: number }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidatePath = path.join(root, entry.name);
    const resolved = await realpath(candidatePath);
    assertContained(root, resolved);
    const candidateStat = await lstat(resolved);
    if (!candidateStat.isDirectory() || !ownedByCurrentProcess(candidateStat)) continue;
    candidates.push({
      path: resolved,
      modifiedAt: candidateStat.mtimeMs,
      bytes: await directoryBytes(resolved),
    });
  }

  let removedDirectories = 0;
  const retained: typeof candidates = [];
  for (const candidate of candidates) {
    if (now() - candidate.modifiedAt > policy.retentionMs) {
      await rm(candidate.path, { recursive: true, force: true });
      removedDirectories += 1;
    } else {
      retained.push(candidate);
    }
  }

  retained.sort((left, right) => left.modifiedAt - right.modifiedAt);
  let retainedBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
  while (retainedBytes > policy.maxBytes && retained.length > 0) {
    const oldest = retained.shift()!;
    await rm(oldest.path, { recursive: true, force: true });
    retainedBytes -= oldest.bytes;
    removedDirectories += 1;
  }
  await assertRunStorageCapacity(root, policy.minFreeBytes);
  return { removedDirectories, retainedBytes };
}

export async function assertRunStorageCapacity(
  targetDirectory: string,
  minimumFreeBytes = runStoragePolicyFromEnvironment().minFreeBytes,
): Promise<void> {
  const fileSystem = await statfs(targetDirectory, { bigint: true });
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  if (freeBytes < BigInt(minimumFreeBytes)) {
    throw new SfudError(
      'FILESYSTEM_ERROR',
      `run 저장소 여유 공간이 부족합니다. 필요=${minimumFreeBytes}B 사용가능=${freeBytes}B`,
    );
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) total += await directoryBytes(entryPath);
    else if (entryStat.isFile()) total += entryStat.size;
  }
  return total;
}

function ownedByCurrentProcess(entry: Awaited<ReturnType<typeof lstat>>): boolean {
  return typeof process.getuid !== 'function' || entry.uid === process.getuid();
}

function assertContained(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SfudError('FILESYSTEM_ERROR', 'run 경로가 저장소 밖을 가리킵니다.');
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SfudError('INVALID_ARGUMENT', 'run 저장소 제한 설정은 0보다 큰 숫자여야 합니다.');
  }
  return parsed;
}
