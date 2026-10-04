import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeploymentAdmissionRepository } from '../src/deploy/deployment-admission-repository.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

const stores: SqliteStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('배포 접수 준비 SQLite lease', () => {
  it('사용자별·전체 한도를 원자적으로 적용하고 만료 lease를 회수한다', async () => {
    const store = await memoryStore();
    const users = new UserRepository(store.database);
    const firstUser = await users.create({ email: 'first@example.com', displayName: 'First', role: 'DEPLOYER' });
    const secondUser = await users.create({ email: 'second@example.com', displayName: 'Second', role: 'DEPLOYER' });
    let now = Date.parse('2026-09-21T00:00:00.000Z');
    let nextId = 0;
    const admissions = new DeploymentAdmissionRepository(store.database, {
      maximumPerUser: 2, maximumTotal: 3, leaseMs: 60_000,
      now: () => now, createId: () => `lease-${nextId += 1}`,
    });

    const first = await admissions.reserve(firstUser.id);
    const second = await admissions.reserve(firstUser.id);
    const third = await admissions.reserve(secondUser.id);
    await expect(admissions.reserve(firstUser.id)).rejects.toMatchObject({ code: 'REQUEST_USER_LIMIT' });
    const thirdUser = await users.create({ email: 'third@example.com', displayName: 'Third', role: 'DEPLOYER' });
    await expect(admissions.reserve(thirdUser.id)).rejects.toMatchObject({ code: 'REQUEST_CAPACITY_EXCEEDED' });

    await first.release();
    await expect(admissions.reserve(thirdUser.id)).resolves.toMatchObject({ release: expect.any(Function) });
    await second.release();
    await third.release();

    const expiring = await admissions.reserve(firstUser.id);
    now += 60_000;
    await expect(admissions.reserve(firstUser.id)).resolves.toMatchObject({ release: expect.any(Function) });
    await expiring.release();
  });

  it('별도 SQLite 연결도 하나의 전체 준비 한도를 공유한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-admission-'));
    directories.push(root);
    const databasePath = path.join(root, 'sfud.db');
    const firstStore = await persistentStore(databasePath);
    const secondStore = await persistentStore(databasePath);
    const user = await new UserRepository(firstStore.database).create({
      email: 'shared@example.com', displayName: 'Shared', role: 'DEPLOYER',
    });
    const first = new DeploymentAdmissionRepository(firstStore.database, { maximumTotal: 1 });
    const second = new DeploymentAdmissionRepository(secondStore.database, { maximumTotal: 1 });

    const results = await Promise.allSettled([first.reserve(user.id), second.reserve(user.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const lease = results.find((result): result is PromiseFulfilledResult<{ release(): Promise<void> }> => result.status === 'fulfilled')!;
    await lease.value.release();
    await expect(second.reserve(user.id)).resolves.toMatchObject({ release: expect.any(Function) });
  });
});

async function memoryStore(): Promise<SqliteStore> {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  stores.push(store);
  return store;
}

async function persistentStore(databasePath: string): Promise<SqliteStore> {
  const store = await openSqliteStore({ databasePath });
  stores.push(store);
  return store;
}
