import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DatabaseExecutor } from './database-executor.js';
import { prepareRunStorage, runStoragePolicyFromEnvironment, type RunStoragePolicy } from './run-storage.js';

/** 웹 런타임의 파일 저장소 수명과 주기 정리를 담당한다. */
export class RuntimeRunStorage {
  private timer: NodeJS.Timeout | undefined;
  private cleaning: Promise<unknown> | undefined;

  private constructor(
    public readonly directory: string,
    private readonly temporaryRoot: string | undefined,
    private readonly database: DatabaseExecutor,
    private readonly policy: RunStoragePolicy,
  ) {}

  public static async create(databasePath: string, database: DatabaseExecutor): Promise<RuntimeRunStorage> {
    const policy = runStoragePolicyFromEnvironment();
    const temporaryRoot = databasePath === ':memory:'
      ? await mkdtemp(path.join(os.tmpdir(), 'sfud-runtime-'))
      : undefined;
    const storage = new RuntimeRunStorage(
      path.join(temporaryRoot ?? path.dirname(path.resolve(databasePath)), 'runs'),
      temporaryRoot,
      database,
      policy,
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

  public clean(now: () => number = Date.now): Promise<unknown> {
    if (this.cleaning !== undefined) return this.cleaning;
    this.cleaning = prepareRunStorage(this.directory, this.policy, now, async () => {
      const jobs = await this.database.all<Array<{ id: string; run_directory: string | null; protected: number }>>(`
        SELECT id, run_directory, CASE WHEN status IN ('QUEUED', 'DRY_RUN_RUNNING', 'DEPLOYING', 'RECONCILE_REQUIRED')
          OR (status = 'APPROVAL_PENDING' AND julianday(completed_at) >= julianday(?) - 30.0 / 1440)
          OR id IN (
            SELECT dry_run_job_id FROM deployment_jobs WHERE status IN ('QUEUED', 'DEPLOYING', 'RECONCILE_REQUIRED')
          ) THEN 1 ELSE 0 END AS protected FROM deployment_jobs
        UNION ALL
        SELECT id, run_directory, CASE WHEN status IN ('QUEUED', 'RUNNING') THEN 1 ELSE 0 END AS protected
        FROM comparison_jobs
      `, new Date(now()).toISOString());
      const knownPaths = new Set<string>();
      const protectedPaths = new Set<string>();
      for (const job of jobs) {
        const paths = [path.join(this.directory, job.id), ...(job.run_directory === null ? [] : [path.resolve(job.run_directory)])];
        for (const directory of paths) {
          knownPaths.add(directory);
          if (job.protected === 1) protectedPaths.add(directory);
        }
      }
      // DB가 추적하지 않는 CLI 작업이나 job 생성 전의 공유 입력도 삭제하지 않는다.
      for (const name of await readdir(this.directory)) {
        const directory = path.join(this.directory, name);
        if (!knownPaths.has(directory)) protectedPaths.add(directory);
      }
      return protectedPaths;
    }).finally(() => { this.cleaning = undefined; });
    return this.cleaning;
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
