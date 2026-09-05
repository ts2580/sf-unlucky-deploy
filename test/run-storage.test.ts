import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRunStorageCapacity,
  prepareRunStorage,
  runStoragePolicyFromEnvironment,
} from '../src/storage/run-storage.js';
import { createRunContext } from '../src/commands/run-context.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('run storage policy', () => {
  it('동시에 정리해도 사라진 경로를 건너뛰며 보호된 payload를 삭제하지 않는다', async () => {
    const root = await temporaryRoot();
    const protectedRun = await runDirectory(root, 'active', 80, 1_000);
    for (let i = 0; i < 15; i += 1) await runDirectory(root, `expired-${i}`, 80, 1_000);
    const policy = { retentionMs: 5_000, maxBytes: 1, minFreeBytes: 1 };
    await Promise.all(Array.from({ length: 8 }, () => prepareRunStorage(
      root, policy, () => 10_000, async () => new Set([protectedRun]),
    )));
    await expect(access(path.join(protectedRun, 'artifact.bin'))).resolves.toBeUndefined();
  });

  it('보호 목록 조회가 실패하면 삭제를 시작하지 않는다', async () => {
    const root = await temporaryRoot();
    const active = await runDirectory(root, 'active', 80, 1_000);
    await expect(prepareRunStorage(root, { retentionMs: 1, maxBytes: 1, minFreeBytes: 1 }, () => 10_000,
      async () => { throw new Error('database offline'); },
    )).rejects.toThrow('database offline');
    await expect(access(active)).resolves.toBeUndefined();
  });

  it('보존 기간이 지난 실행과 quota를 넘긴 오래된 실행부터 정리한다', async () => {
    const root = await temporaryRoot();
    const expired = await runDirectory(root, 'expired', 80, 1_000);
    const oldest = await runDirectory(root, 'oldest', 80, 8_000);
    const newest = await runDirectory(root, 'newest', 80, 9_000);

    const result = await prepareRunStorage(root, {
      retentionMs: 5_000,
      maxBytes: 100,
      minFreeBytes: 1,
    }, () => 10_000);

    expect(result).toEqual({ removedDirectories: 2, retainedBytes: 80 });
    await expect(access(expired)).rejects.toThrow();
    await expect(access(oldest)).rejects.toThrow();
    await expect(access(newest)).resolves.toBeUndefined();
  });

  it('snapshot 시작 전 최소 여유 공간과 환경 설정을 검증한다', async () => {
    const root = await temporaryRoot();
    await expect(assertRunStorageCapacity(root, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/여유 공간/u);
    expect(runStoragePolicyFromEnvironment({
      SFUD_RUN_RETENTION_HOURS: '12',
      SFUD_RUN_MAX_BYTES: '2048',
      SFUD_RUN_MIN_FREE_BYTES: '1024',
    })).toEqual({
      retentionMs: 12 * 60 * 60 * 1_000,
      maxBytes: 2_048,
      minFreeBytes: 1_024,
    });
    expect(() => runStoragePolicyFromEnvironment({ SFUD_RUN_MAX_BYTES: '0' })).toThrow(/0보다 큰/u);
  });

  it.each(['compare', 'deploy'] as const)('%s snapshot context를 생성할 때마다 여유 공간을 다시 검사한다', async (command) => {
    const root = await temporaryRoot();
    vi.stubEnv('SFUD_RUN_MIN_FREE_BYTES', String(Number.MAX_SAFE_INTEGER));

    await expect(createRunContext(root, `${command}-run`, command)).rejects.toThrow(/여유 공간/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-run-storage-'));
  roots.push(root);
  return root;
}

async function runDirectory(
  root: string,
  name: string,
  bytes: number,
  modifiedAt: number,
): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, 'artifact.bin'), Buffer.alloc(bytes));
  const timestamp = new Date(modifiedAt);
  await utimes(directory, timestamp, timestamp);
  return directory;
}
