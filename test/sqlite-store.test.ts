import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

import {
  DeploymentCoordinator,
  ReconciliationRequiredError,
} from '../src/deploy/deployment-coordinator.js';
import { ComparisonJobRepository } from '../src/compare/comparison-job-repository.js';
import { DeploymentJobRepository } from '../src/deploy/deployment-job-repository.js';
import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { applyMigrations } from '../src/storage/migrations.js';
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
      .toEqual({ count: 18 });
    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(databasePath))).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    }
    await expect(readFile(databasePath)).resolves.toBeInstanceOf(Buffer);
  });

  it('트랜잭션 롤백 중 독립 쿼리를 대기시키고 롤백 뒤 순서대로 실행한다', async () => {
    const store = await openMemoryStore();
    await store.database.exec(`
      CREATE TABLE executor_regression (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    await store.database.run(`
      INSERT INTO executor_regression (id, value) VALUES ('inside', 'initial'), ('outside', 'initial')
    `);

    const entered = deferred<void>();
    const release = deferred<void>();
    const transaction = store.database.transaction(async (database) => {
      await database.run("UPDATE executor_regression SET value = 'rolled-back' WHERE id = 'inside'");
      entered.resolve();
      await release.promise;
      throw new Error('rollback requested');
    });
    const rejected = expect(transaction).rejects.toThrow('rollback requested');

    await entered.promise;
    let outsideSettled = false;
    const outsideWrite = store.database.run(
      "UPDATE executor_regression SET value = 'committed' WHERE id = 'outside'",
    ).then(() => {
      outsideSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outsideSettled).toBe(false);

    release.resolve();
    await rejected;
    await outsideWrite;
    await expect(store.database.all(`
      SELECT id, value FROM executor_regression ORDER BY id
    `)).resolves.toEqual([
      { id: 'inside', value: 'initial' },
      { id: 'outside', value: 'committed' },
    ]);
  });

  it('최근 작업 summary 조회에서 대형 상세 JSON을 읽거나 파싱하지 않는다', async () => {
    const store = await openMemoryStore();
    const users = new UserRepository(store.database, fixedNow, () => 'summary-user');
    const user = await users.create({
      email: 'summary@example.com', displayName: '요약 조회자', role: 'DEPLOYER',
    });
    const deploymentJobs = new DeploymentJobRepository(
      store.database,
      fixedNow,
      () => 'summary-deployment',
    );
    const dryRun = await deploymentJobs.createDryRun({
      source: 'local:source', targetAlias: 'target', targetOrgIdentity: orgIdentity('target'),
      manifestPath: 'manifest/package.xml', payloadChecksum: checksum, createdBy: user.id,
    });
    await deploymentJobs.transition(dryRun.id, 'DRY_RUN_RUNNING');
    await recordPreparedArtifacts(deploymentJobs, dryRun.id);
    const deploymentStorage = await store.database.get<{
      comparisonJson: string | null;
      dryRunJson: string | null;
      comparisonPath: string;
      dryRunPath: string;
    }>(`
      SELECT comparison_result_json comparisonJson, dry_run_result_json dryRunJson,
        comparison_artifact_path comparisonPath, dry_run_artifact_path dryRunPath
      FROM deployment_jobs WHERE id = ?
    `, dryRun.id);
    expect(deploymentStorage).toMatchObject({ comparisonJson: null, dryRunJson: null });
    expect(deploymentStorage?.comparisonPath).toMatch(/comparison\.json\.gz$/u);
    expect(deploymentStorage?.dryRunPath).toMatch(/dry-run\.json\.gz$/u);

    await writeFile(deploymentStorage!.comparisonPath, 'invalid compressed artifact');
    await expect(deploymentJobs.getSummary(dryRun.id)).resolves.toEqual(expect.objectContaining({
      id: dryRun.id,
      comparisonSummary: comparisonResult.summary,
    }));
    await expect(deploymentJobs.getRequired(dryRun.id)).rejects.toThrow();

    const comparisonJobs = new ComparisonJobRepository(
      store.database,
      fixedNow,
      () => 'summary-comparison',
    );
    const comparison = await comparisonJobs.create({
      projectPath: '/project', manifestPath: '/project/manifest/package.xml',
      leftSource: 'org:target', rightSource: 'local:source', strict: false,
      showIdentical: false, createdBy: user.id,
    });
    await comparisonJobs.markRunning(comparison.id);
    const comparisonRunDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-summary-comparison-'));
    directories.push(comparisonRunDirectory);
    await comparisonJobs.markSucceeded(comparison.id, comparisonResult, comparisonRunDirectory);
    expect(await store.database.get(`
      SELECT result_json resultJson, result_artifact_path resultPath
      FROM comparison_jobs WHERE id = ?
    `, comparison.id)).toMatchObject({
      resultJson: null,
      resultPath: expect.stringMatching(/comparison\.json\.gz$/u),
    });

    await store.database.run(`
      UPDATE deployment_jobs
      SET comparison_result_json = '{invalid', dry_run_result_json = '{invalid'
      WHERE id = ?
    `, dryRun.id);
    await store.database.run(`
      UPDATE comparison_jobs SET result_json = '{invalid' WHERE id = ?
    `, comparison.id);

    expect(await deploymentJobs.listRecentSummary()).toEqual([
      expect.objectContaining({
        id: dryRun.id,
        comparisonSummary: comparisonResult.summary,
      }),
    ]);
    expect((await deploymentJobs.listRecentSummary())[0]?.comparisonResult).toBeUndefined();
    expect(await comparisonJobs.listRecentSummary()).toEqual([
      expect.objectContaining({
        id: comparison.id,
        summary: comparisonResult.summary,
      }),
    ]);
    expect((await comparisonJobs.listRecentSummary())[0]?.result).toBeUndefined();
    await expect(deploymentJobs.getRequired(dryRun.id)).rejects.toThrow();
    await expect(comparisonJobs.getRequired(comparison.id)).rejects.toThrow();
  });

  it('v8 승인 이력을 보존하면서 직접 배포를 허용하는 v9로 마이그레이션한다', async () => {
    const database = await open({ filename: ':memory:', driver: sqlite3.Database });
    try {
      await database.exec('PRAGMA foreign_keys = ON');
      await applyMigrations(database, fixedNow, 8);
      await database.run(`
        INSERT INTO users (id, email, display_name, role, created_at, updated_at)
        VALUES ('migration-user', 'migration@example.com', 'Migration', 'DEPLOYER', ?, ?)
      `, fixedNow(), fixedNow());
      await database.run(`
        INSERT INTO deployment_jobs (
          id, kind, status, source, target_alias, manifest_path, payload_checksum,
          created_by, created_at, updated_at, is_prepared, scope
        ) VALUES ('migration-dry', 'DRY_RUN', 'APPROVAL_PENDING', 'local:source', 'target',
          'manifest.xml', ?, 'migration-user', ?, ?, 1, 'MANIFEST')
      `, checksum, fixedNow(), fixedNow());
      await database.run(`
        INSERT INTO deployment_jobs (
          id, kind, status, source, target_alias, manifest_path, payload_checksum,
          dry_run_job_id, created_by, created_at, updated_at, is_prepared, scope
        ) VALUES ('migration-deploy', 'DEPLOY', 'SUCCEEDED', 'local:source', 'target',
          'manifest.xml', ?, 'migration-dry', 'migration-user', ?, ?, 0, 'MANIFEST')
      `, checksum, fixedNow(), fixedNow());
      await database.run(`
        INSERT INTO deployment_approvals (
          id, dry_run_job_id, deploy_job_id, approved_by, payload_checksum, target_alias, approved_at
        ) VALUES ('migration-approval', 'migration-dry', 'migration-deploy',
          'migration-user', ?, 'target', ?)
      `, checksum, fixedNow());

      await applyMigrations(database, fixedNow, 9);
      await expect(database.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
      await expect(database.get('SELECT COUNT(*) count FROM deployment_approvals'))
        .resolves.toEqual({ count: 1 });
      await expect(database.get('SELECT COUNT(*) count FROM deployment_jobs'))
        .resolves.toEqual({ count: 2 });
      await expect(database.run(`
        INSERT INTO deployment_jobs (
          id, kind, status, source, target_alias, manifest_path, payload_checksum,
          created_by, created_at, updated_at, is_prepared, scope
        ) VALUES ('migration-direct', 'DEPLOY', 'QUEUED', 'local:source', 'target',
          'manifest.xml', ?, 'migration-user', ?, ?, 0, 'MANIFEST')
      `, checksum, fixedNow(), fixedNow())).resolves.toMatchObject({ changes: 1 });
    } finally {
      await database.close();
    }
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
      targetOrgIdentity: orgIdentity('stdOrg'),
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
      prepared: true,
      comparisonResult,
      testPlan: { level: 'RunLocalTests', tests: [], selection: 'fallback' },
      dryRunResult: { status: 0, result: { id: '0Af-dry-run' } },
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
    })).resolves.toMatchObject({ id: deploy.id });
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
      targetOrgIdentity: orgIdentity('stdOrg'),
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

  it('30분이 지난 dry-run 승인을 거부한다', async () => {
    const store = await openMemoryStore();
    let now = '2026-08-23T00:00:00.000Z';
    const ids = ['expiry-deployer', 'expiry-dry-run'];
    const users = new UserRepository(store.database, () => now, () => ids.shift()!);
    const jobs = new DeploymentJobRepository(store.database, () => now, () => ids.shift()!);
    const deployer = await users.create({
      email: 'expiry@example.com', displayName: '승인 만료 검증', role: 'DEPLOYER',
    });
    const dryRun = await jobs.createDryRun({
      source: 'local:sf-project', targetAlias: 'stdOrg', targetOrgIdentity: orgIdentity('stdOrg'),
      manifestPath: 'manifest/package.xml', payloadChecksum: checksum, createdBy: deployer.id,
    });
    await jobs.transition(dryRun.id, 'DRY_RUN_RUNNING');
    await recordPreparedArtifacts(jobs, dryRun.id);
    await jobs.transition(dryRun.id, 'APPROVAL_PENDING');
    now = '2026-08-23T00:31:00.000Z';

    await expect(jobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id, approvedBy: deployer.id, payloadChecksum: checksum,
      targetAlias: 'stdOrg', confirmation: '실제 배포',
    })).rejects.toThrow(/유효시간 30분/u);
  });

  it('성공한 dry-run 없이도 권한과 확인 문구를 검증해 직접 배포를 기록한다', async () => {
    const store = await openMemoryStore();
    const ids = ['direct-deployer', 'direct-deploy-1'];
    const users = new UserRepository(store.database, fixedNow, () => ids.shift()!);
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => ids.shift()!);
    const deployer = await users.create({
      email: 'direct@example.com', displayName: '직접 배포자', role: 'DEPLOYER',
    });

    const { job: deploy, created } = await jobs.createDirectDeployment({
      source: 'local:sf-project', targetAlias: 'sandbox', targetConfirmation: 'sandbox',
      targetOrgIdentity: orgIdentity('sandbox'),
      confirmation: '실제 배포', manifestPath: 'manifest/package.xml', payloadChecksum: checksum,
      clientRequestId: 'direct-request-1', requestHash: checksum,
      createdBy: deployer.id, requestedTestLevel: 'NoTestRun', requestedTests: [],
      selectedComponents: [{ type: 'CustomObject', fullName: 'Book__c' }],
    });

    expect(deploy).toMatchObject({
      id: 'direct-deploy-1', kind: 'DEPLOY', status: 'QUEUED', targetAlias: 'sandbox',
      selectedComponents: [{ type: 'CustomObject', fullName: 'Book__c' }],
    });
    expect(created).toBe(true);
    expect(deploy.testPlan).toBeUndefined();
    expect(deploy.dryRunJobId).toBeUndefined();
    await expect(jobs.createDirectDeployment({
      source: 'local:sf-project', targetAlias: 'sandbox', targetConfirmation: 'production',
      targetOrgIdentity: orgIdentity('sandbox'),
      confirmation: '실제 배포', manifestPath: 'manifest/package.xml', payloadChecksum: checksum,
      clientRequestId: 'direct-request-2', requestHash: checksum,
      createdBy: deployer.id, requestedTestLevel: 'NoTestRun', requestedTests: [],
    })).rejects.toThrow(/대상 org 별칭/u);
  });

  it('재시작 시 실행 중 작업을 재확인 필요 상태로 전환한다', async () => {
    const store = await openMemoryStore();
    const jobs = new DeploymentJobRepository(store.database, fixedNow, () => 'dry-run-recovery');
    const job = await jobs.createDryRun({
      source: 'local:sf-project',
      targetAlias: 'stdOrg',
      targetOrgIdentity: orgIdentity('stdOrg'),
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
      targetOrgIdentity: orgIdentity('stdOrg'),
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
      targetOrgIdentity: orgIdentity('stdOrg'),
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixedNow(): string {
  return '2026-08-23T00:00:00.000Z';
}

function orgIdentity(alias: string) {
  return { alias, username: `${alias}@example.com`, orgId: `00D${alias.padEnd(12, '0')}` };
}

async function recordPreparedArtifacts(jobs: DeploymentJobRepository, id: string): Promise<void> {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), `sfud-artifacts-${id}-`));
  directories.push(runDirectory);
  await jobs.recordDryRunArtifacts({
    id,
    payloadChecksum: checksum,
    runDirectory,
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
