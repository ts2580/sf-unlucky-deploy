import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeploymentCoordinator } from '../src/deploy/deployment-coordinator.js';
import { DeploymentExecutionLeaseRepository } from '../src/deploy/deployment-execution-lease-repository.js';
import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';
import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('배포 실행 SQLite lease', () => {
  it('서로 다른 SQLite 연결은 실행 slot 하나와 만료 후 회수를 공유한다', async () => {
    const { firstStore, secondStore } = await persistentStores();
    const actor = await new UserRepository(firstStore.database).create({
      email: 'lease@example.com', displayName: 'Lease', role: 'DEPLOYER',
    });
    const firstJob = await queuedDryRun(new DeploymentJobRepository(firstStore.database), actor.id, 'first-lease');
    const secondJob = await queuedDryRun(new DeploymentJobRepository(secondStore.database), actor.id, 'second-lease');
    let now = Date.parse('2026-09-21T00:00:00.000Z');
    const first = new DeploymentExecutionLeaseRepository(firstStore.database, {
      leaseMs: 60_000, now: () => now, createId: () => 'first-lease',
    });
    const second = new DeploymentExecutionLeaseRepository(secondStore.database, {
      leaseMs: 60_000, now: () => now, createId: () => 'second-lease',
    });

    const lease = await first.tryAcquire(firstJob.id);
    expect(lease).toBeDefined();
    await expect(second.tryAcquire(secondJob.id)).resolves.toBeUndefined();
    now += 30_000;
    await expect(lease!.renew()).resolves.toBe(true);
    now += 59_999;
    await expect(second.tryAcquire(secondJob.id)).resolves.toBeUndefined();
    now += 1;
    await expect(second.tryAcquire(secondJob.id)).resolves.toMatchObject({ release: expect.any(Function) });
  });

  it('각 프로세스의 local queue가 있어도 Salesforce 작업은 하나씩 시작한다', async () => {
    const { firstStore, secondStore } = await persistentStores();
    const actor = await new UserRepository(firstStore.database).create({
      email: 'operator@example.com', displayName: 'Operator', role: 'DEPLOYER',
    });
    const firstJobs = new DeploymentJobRepository(firstStore.database);
    const secondJobs = new DeploymentJobRepository(secondStore.database);
    const firstJob = await queuedDryRun(firstJobs, actor.id, 'first');
    const secondJob = await queuedDryRun(secondJobs, actor.id, 'second');
    const firstCoordinator = new DeploymentCoordinator(
      firstJobs,
      new SingleJobQueue(),
      new DeploymentExecutionLeaseRepository(firstStore.database),
    );
    const secondCoordinator = new DeploymentCoordinator(
      secondJobs,
      new SingleJobQueue(),
      new DeploymentExecutionLeaseRepository(secondStore.database),
    );
    let releaseFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let notifyFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { notifyFirstStarted = resolve; });
    const started: string[] = [];

    const first = firstCoordinator.runDryRun(firstJob.id, async () => {
      started.push(firstJob.id);
      notifyFirstStarted!();
      await firstFinished;
      return {};
    });
    await firstStarted;
    const second = secondCoordinator.runDryRun(secondJob.id, async () => {
      started.push(secondJob.id);
      return {};
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(started).toEqual([firstJob.id]);
    releaseFirst!();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(started).toEqual([firstJob.id, secondJob.id]);
  });
});

async function persistentStores(): Promise<{ firstStore: SqliteStore; secondStore: SqliteStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-execution-lease-'));
  directories.push(root);
  const databasePath = path.join(root, 'sfud.db');
  const firstStore = await openSqliteStore({ databasePath });
  const secondStore = await openSqliteStore({ databasePath });
  stores.push(firstStore, secondStore);
  return { firstStore, secondStore };
}

async function queuedDryRun(jobs: DeploymentJobRepository, createdBy: string, suffix: string) {
  return await jobs.createDryRun({
    source: `local:/fixture/${suffix}`,
    targetAlias: 'target',
    manifestPath: '@all',
    payloadChecksum: 'a'.repeat(64),
    createdBy,
    targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
  });
}
