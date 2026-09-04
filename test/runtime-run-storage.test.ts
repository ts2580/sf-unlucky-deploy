import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeRunStorage } from '../src/storage/runtime-run-storage.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('웹 런타임 실행 저장소', () => {
  it('메모리 DB마다 파일 저장소를 격리하고 해당 런타임의 임시 파일만 제거한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    const first = await RuntimeRunStorage.create(':memory:', store.database);
    const second = await RuntimeRunStorage.create(':memory:', store.database);
    try {
      expect(first.directory).not.toBe(second.directory);
      expect(first.directory).not.toBe(path.join(process.cwd(), '.sfud', 'runs'));
      const sentinel = path.join(second.directory, 'keep.txt');
      await writeFile(sentinel, 'keep');
      await first.close();
      await expect(access(first.directory)).rejects.toThrow();
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally { await first.close(); await second.close(); await store.close(); }
  });

  it('실행 중, 재확인, 유효한 승인 및 대기 배포가 참조한 payload를 quota보다 우선 보호한다', async () => {
    vi.stubEnv('SFUD_RUN_MAX_BYTES', '1');
    const store = await openSqliteStore({ databasePath: ':memory:' });
    const storage = await RuntimeRunStorage.create(':memory:', store.database);
    const now = Date.now();
    const jobs = new DeploymentJobRepository(store.database);
    const create = async () => jobs.createDryRun({
      source: 'local:/fixture', targetAlias: 'target', manifestPath: '@all', payloadChecksum: 'a'.repeat(64),
      targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
    });
    try {
      const active = await create();
      const approval = await create();
      const reconcile = await create();
      const expiredApproval = await create();
      const referenced = await create();
      const queuedDeployment = await create();
      for (const job of [approval, reconcile, expiredApproval, referenced]) await jobs.transition(job.id, 'DRY_RUN_RUNNING');
      for (const job of [approval, expiredApproval, referenced]) await jobs.transition(job.id, 'APPROVAL_PENDING');
      await jobs.transition(reconcile.id, 'RECONCILE_REQUIRED');
      for (const job of [expiredApproval, referenced]) {
        await store.database.run('UPDATE deployment_jobs SET completed_at = ? WHERE id = ?', new Date(now - 3_600_000).toISOString(), job.id);
      }
      await store.database.run("UPDATE deployment_jobs SET kind = 'DEPLOY', dry_run_job_id = ? WHERE id = ?", referenced.id, queuedDeployment.id);
      for (const job of [active, approval, reconcile, expiredApproval, referenced]) {
        await artifact(storage.directory, job.id, now - 8 * 24 * 3_600_000);
      }
      const cliRun = await artifact(storage.directory, 'untracked-cli-run', now - 8 * 24 * 3_600_000);
      await storage.clean(() => now);
      await expect(access(cliRun)).resolves.toBeUndefined();
      for (const job of [active, approval, reconcile, referenced]) {
        await expect(access(path.join(storage.directory, job.id, 'artifact'))).resolves.toBeUndefined();
      }
      await expect(access(path.join(storage.directory, expiredApproval.id))).rejects.toThrow();
    } finally { await storage.close(); await store.close(); }
  });

  it('서버 재시작 없이 주기적으로 만료된 실행을 정리한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    const storage = await RuntimeRunStorage.create(':memory:', store.database);
    try {
      const jobs = new DeploymentJobRepository(store.database);
      const job = await jobs.createDryRun({
        source: 'local:/fixture', targetAlias: 'target', manifestPath: '@all', payloadChecksum: 'a'.repeat(64),
        targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
      });
      await jobs.transition(job.id, 'FAILED');
      const expired = await artifact(storage.directory, job.id, Date.now() - 8 * 24 * 3_600_000);
      storage.start(10);
      await vi.waitFor(async () => { await expect(access(expired)).rejects.toThrow(); });
    } finally { await storage.close(); await store.close(); }
  });

  it('영구 DB 종료 시 실행 기록을 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-storage-test-'));
    const store = await openSqliteStore({ databasePath: path.join(root, 'sfud.db') });
    const storage = await RuntimeRunStorage.create(store.databasePath, store.database);
    try {
      const retained = await artifact(storage.directory, 'retained', Date.now());
      await storage.close();
      await expect(access(retained)).resolves.toBeUndefined();
    } finally { await storage.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
  });
});

async function artifact(root: string, name: string, modifiedAt: number): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory);
  await writeFile(path.join(directory, 'artifact'), 'payload');
  await utimes(directory, new Date(modifiedAt), new Date(modifiedAt));
  return directory;
}
