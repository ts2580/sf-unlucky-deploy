import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DatabaseExecutor } from './database-executor.js';
import { SfudError } from '../core/errors.js';
import {
  prepareRunStorage,
  runStoragePolicyFromEnvironment,
  type RunStorageCleanupResult,
  type RunStoragePolicy,
} from './run-storage.js';

/** 웹 런타임의 파일 저장소 수명과 주기 정리를 담당한다. */
export class RuntimeRunStorage {
  private timer: NodeJS.Timeout | undefined;
  private cleaning: Promise<RunStorageCleanupResult> | undefined;

  private constructor(
    public readonly directory: string,
    private readonly temporaryRoot: string | undefined,
    private readonly database: DatabaseExecutor,
    private readonly policy: RunStoragePolicy,
    private readonly beforeClean: (() => Promise<void>) | undefined,
  ) {}

  public static async create(
    databasePath: string,
    database: DatabaseExecutor,
    beforeClean?: () => Promise<void>,
  ): Promise<RuntimeRunStorage> {
    const policy = runStoragePolicyFromEnvironment();
    const temporaryRoot = databasePath === ':memory:'
      ? await mkdtemp(path.join(os.tmpdir(), 'sfud-runtime-'))
      : undefined;
    const storage = new RuntimeRunStorage(
      path.join(temporaryRoot ?? path.dirname(path.resolve(databasePath)), 'runs'),
      temporaryRoot,
      database,
      policy,
      beforeClean,
    );
    try {
      await storage.clean();
      return storage;
    } catch (error) {
      await storage.close();
      throw error;
    }
  }

  public start(intervalMs = 60_000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.clean().catch(() => {
        // 파일 경로 등 내부 오류 상세를 공개 로그에 노출하지 않는다.
        process.stderr.write('[RUN_STORAGE_CLEANUP_FAILED] 실행 기록 정리에 실패했습니다. 다음 주기에 재시도합니다.\n');
      });
    }, intervalMs);
    this.timer.unref();
  }

  public clean(now: () => number = Date.now): Promise<RunStorageCleanupResult> {
    if (this.cleaning !== undefined) return this.cleaning;
    this.cleaning = (async () => {
      await this.beforeClean?.();
      return await prepareRunStorage(this.directory, this.policy, now, async () => {
      const jobs = await this.database.all<Array<{
        id: string;
        run_directory: string | null;
        manifest_path: string;
        protected: number;
      }>>(`
        SELECT id, run_directory, manifest_path, CASE WHEN status IN ('QUEUED', 'DRY_RUN_RUNNING', 'DEPLOYING', 'RECONCILE_REQUIRED', 'VALIDATED_PENDING_EXECUTION')
          OR (status = 'APPROVAL_PENDING' AND julianday(completed_at) >= julianday(?) - 30.0 / 1440)
          OR id IN (
            SELECT dry_run_job_id FROM deployment_jobs WHERE status IN ('QUEUED', 'DEPLOYING', 'RECONCILE_REQUIRED', 'VALIDATED_PENDING_EXECUTION')
          ) THEN 1 ELSE 0 END AS protected FROM deployment_jobs
        UNION ALL
        SELECT id, run_directory, '' AS manifest_path, CASE WHEN status IN ('QUEUED', 'RUNNING') THEN 1 ELSE 0 END AS protected
        FROM comparison_jobs
      `, new Date(now()).toISOString());
      const knownPaths = new Set<string>();
      const protectedPaths = new Set<string>();
      const legacySelectedManifests = path.resolve(this.directory, 'selected-manifests');
      for (const job of jobs) {
        const paths = [path.join(this.directory, job.id), ...(job.run_directory === null ? [] : [path.resolve(job.run_directory)])];
        for (const directory of paths) {
          knownPaths.add(directory);
          if (job.protected === 1) protectedPaths.add(directory);
        }
        if (isWithinDirectory(legacySelectedManifests, job.manifest_path)) {
          knownPaths.add(legacySelectedManifests);
          if (job.protected === 1) protectedPaths.add(legacySelectedManifests);
        }
      }
      // DB가 추적하지 않는 CLI 작업은 삭제하지 않는다. 레거시 selected-manifests만은
      // DB 참조가 없을 때 보존 정책으로 정리할 수 있다.
      for (const name of await readdir(this.directory)) {
        const directory = path.join(this.directory, name);
        if (!knownPaths.has(directory) && path.resolve(directory) !== legacySelectedManifests) protectedPaths.add(directory);
      }
        return protectedPaths;
      });
    })().finally(() => { this.cleaning = undefined; });
    return this.cleaning;
  }

  /**
   * 활성·승인 대기 payload는 quota를 넘겨도 삭제하지 않는다. 그 상태에서는
   * 새 요청을 받아 더 악화시키지 않고, 정리 또는 기존 작업 종료를 기다린다.
   */
  public async assertCanAcceptNewRun(): Promise<void> {
    const result = await this.clean();
    if (result.retainedBytes > this.policy.maxBytes) {
      throw new SfudError(
        'REQUEST_CAPACITY_EXCEEDED',
        `보호 중인 실행 기록이 run 저장소 한도(${this.policy.maxBytes}B)를 초과했습니다. 기존 작업이 끝나거나 보존 기간이 지나면 다시 시도하세요.`,
      );
    }
  }

  public async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.cleaning?.catch(() => undefined);
    if (this.temporaryRoot !== undefined) {
      await rm(this.temporaryRoot, { recursive: true, force: true });
    }
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved !== directory && resolved.startsWith(`${directory}${path.sep}`);
}
