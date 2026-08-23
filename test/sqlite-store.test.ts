import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DeploymentCoordinator,
  ReconciliationRequiredError,
} from '../src/deploy/deployment-coordinator.js';
import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';
import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';
import type { ComparisonResult } from '../src/metadata/comparator.js';

const stores: SqliteStore[] = [];
const directories: string[] = [];
const checksum = 'a'.repeat(64);

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('SQLite 저장소', () => {
  it('마이그레이션과 운영 PRAGMA를 적용하고 DB 권한을 제한한다', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sfud-db-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'data', 'sfud.db');
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o755 });
    await chmod(path.dirname(databasePath), 0o755);
    const store = await openSqliteStore({ databasePath, now: () => '2026-08-23T00:00:00.000Z' });
    stores.push(store);

    expect(await store.database.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(await store.database.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(await store.database.get('PRAGMA busy_timeout')).toEqual({ timeout: 5_000 });
    expect(await store.database.get('SELECT COUNT(*) count FROM schema_migrations'))
      .toEqual({ count: 4 });
    expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    await expect(readFile(databasePath)).resolves.toBeInstanceOf(Buffer);
  });

  it('성공한 dry-run의 동일 payload만 권한 있는 사용자가 승인한다', async () => {
    const store = await openMemoryStore();
    const ids = ['user-deployer', 'dry-run-1', 'deploy-1', 'approval-1'];
    const users = new UserRepository(store.database, fixedNow, () => ids.shift()!);
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => ids.shift()!);
    const deployer = await users.create({
      email: 'DEPLOYER@example.com',
      displayName: '배포 담당자',
      role: 'DEPLOYER',
    });
    const dryRun = await jobs.createDryRun({
      source: 'local:sf-project',
      targetAlias: 'stdOrg',
      manifestPath: 'manifest/package.xml',
      payloadChecksum: checksum,
      runDirectory: '.sfud/runs/dry-run-1',
      createdBy: deployer.id,
    });

    expect((await jobs.transition(dryRun.id, 'DRY_RUN_RUNNING')).status).toBe('DRY_RUN_RUNNING');
    await recordPreparedArtifacts(jobs, dryRun.id);
    expect((await jobs.transition(dryRun.id, 'APPROVAL_PENDING', {
      salesforceDeploymentId: '0Af-dry-run',
    })).status).toBe('APPROVAL_PENDING');

    const deploy = await jobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id,
      approvedBy: deployer.id,
      payloadChecksum: checksum,
      targetAlias: 'stdOrg',
      confirmation: '실제 배포',
    });

    expect(deploy).toMatchObject({
      id: 'deploy-1',
      kind: 'DEPLOY',
      status: 'QUEUED',
      dryRunJobId: dryRun.id,
      payloadChecksum: checksum,
      targetAlias: 'stdOrg',
    });
    const coordinator = new DeploymentCoordinator(jobs, new SingleJobQueue());
    expect(await coordinator.runDeployment(deploy.id, async () => ({
      deploymentId: '0Af-deploy',
    }))).toMatchObject({
      status: 'SUCCEEDED',
      salesforceDeploymentId: '0Af-deploy',
    });
    await expect(jobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id,
      approvedBy: deployer.id,
      payloadChecksum: checksum,
      targetAlias: 'stdOrg',
      confirmation: '실제 배포',
    })).rejects.toThrow(/이미 실제 배포가 승인/u);
  });

  it('checksum 변경, 권한 부족, 잘못된 상태 전이를 차단한다', async () => {
    const store = await openMemoryStore();
    const ids = ['viewer-1', 'dry-run-2'];
    const users = new UserRepository(store.database, fixedNow, () => ids.shift()!);
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => ids.shift()!);
    const viewer = await users.create({
      email: 'viewer@example.com',
      displayName: '조회자',
      role: 'VIEWER',
    });
    const dryRun = await jobs.createDryRun({
      source: 'org:aladin',
      targetAlias: 'stdOrg',
      manifestPath: 'manifest/package.xml',
      payloadChecksum: checksum,
      createdBy: viewer.id,
    });

    await expect(jobs.transition(dryRun.id, 'DEPLOYING')).rejects.toThrow(/dry-run 작업/u);
    await jobs.transition(dryRun.id, 'DRY_RUN_RUNNING');
    await recordPreparedArtifacts(jobs, dryRun.id);
    await jobs.transition(dryRun.id, 'APPROVAL_PENDING');
    await expect(jobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id,
      approvedBy: viewer.id,
      payloadChecksum: 'b'.repeat(64),
      targetAlias: 'stdOrg',
      confirmation: '실제 배포',
    })).rejects.toThrow(/checksum이 변경/u);
    await expect(jobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id,
      approvedBy: viewer.id,
      payloadChecksum: checksum,
      targetAlias: 'stdOrg',
      confirmation: '실제 배포',
    })).rejects.toThrow(/승인 권한/u);
  });

  it('재시작 시 실행 중 작업을 재확인 필요 상태로 전환한다', async () => {
    const store = await openMemoryStore();
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => 'dry-run-recovery');
    const job = await jobs.createDryRun({
      source: 'local:sf-project',
      targetAlias: 'stdOrg',
      manifestPath: 'manifest/package.xml',
      payloadChecksum: checksum,
    });
    await jobs.transition(job.id, 'DRY_RUN_RUNNING');

    expect(await jobs.recoverInterruptedJobs()).toBe(1);
    expect(await jobs.getRequired(job.id)).toMatchObject({
      status: 'RECONCILE_REQUIRED',
      errorCode: 'PROCESS_INTERRUPTED',
    });
  });

  it('재시작 전에 시작하지 못한 대기 작업을 실패로 종료해 큐 고착을 막는다', async () => {
    const store = await openMemoryStore();
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => 'dry-run-queued');
    const job = await jobs.createDryRun({
      source: 'local:sf-project', targetAlias: 'stdOrg',
      manifestPath: 'manifest/package.xml', payloadChecksum: checksum,
    });

    expect(await jobs.recoverInterruptedJobs()).toBe(1);
    expect(await jobs.getRequired(job.id)).toMatchObject({
      status: 'FAILED', errorCode: 'PROCESS_INTERRUPTED_BEFORE_START',
    });
  });

  it('Salesforce 결과가 불명확하면 실패로 단정하지 않고 재확인 상태를 기록한다', async () => {
    const store = await openMemoryStore();
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => 'dry-run-unknown');
    const coordinator = new DeploymentCoordinator(jobs, new SingleJobQueue());
    const job = await jobs.createDryRun({
      source: 'local:sf-project',
      targetAlias: 'stdOrg',
      manifestPath: 'manifest/package.xml',
      payloadChecksum: checksum,
    });

    await expect(coordinator.runDryRun(job.id, async () => {
      throw new ReconciliationRequiredError('Salesforce 응답 대기 중 연결이 끊겼습니다.', '0Af-unknown');
    })).rejects.toThrow(/연결이 끊겼습니다/u);
    expect(await jobs.getRequired(job.id)).toMatchObject({
      status: 'RECONCILE_REQUIRED',
      salesforceDeploymentId: '0Af-unknown',
      errorCode: 'EXTERNAL_STATE_UNKNOWN',
    });
  });
});

async function openMemoryStore(): Promise<SqliteStore> {
  const store = await openSqliteStore({ databasePath: ':memory:', now: fixedNow });
  stores.push(store);
  return store;
}

function fixedNow(): string {
  return '2026-08-23T00:00:00.000Z';
}

async function recordPreparedArtifacts(jobs: DeploymentJobRepository, id: string): Promise<void> {
  await jobs.recordDryRunArtifacts({
    id,
    payloadChecksum: checksum,
    runDirectory: `.sfud/runs/${id}`,
    comparisonResult,
    testPlan: { level: 'RunLocalTests', tests: [], selection: 'fallback' },
    dryRunResult: { status: 0, result: { id: '0Af-dry-run' } },
  });
}

const comparisonResult: ComparisonResult = {
  generatedAt: '2026-08-23T00:00:00.000Z',
  strict: false,
  left: { displayName: 'stdOrg', kind: 'org', manifestSha256: checksum, payloadSha256: checksum },
  right: { displayName: 'source', kind: 'local', manifestSha256: checksum, payloadSha256: checksum },
  summary: { added: 0, removed: 0, modified: 0, identical: 0, total: 0, different: 0 },
  components: [],
  warnings: [],
};
