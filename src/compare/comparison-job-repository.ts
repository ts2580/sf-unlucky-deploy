import { randomUUID } from 'node:crypto';

import type { ComparisonResult } from '../metadata/comparator.js';
import type { DatabaseExecutor, DatabaseHandle } from '../storage/database-executor.js';
import { runInImmediateTransaction } from '../storage/transaction.js';

export type ComparisonJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type ComparisonScope = 'MANIFEST' | 'ALL';

export interface ComparisonJob {
  id: string;
  status: ComparisonJobStatus;
  scope: ComparisonScope;
  metadataType?: string;
  projectPath: string;
  manifestPath: string;
  leftSource: string;
  rightSource: string;
  strict: boolean;
  showIdentical: boolean;
  createdBy: string;
  runDirectory?: string;
  result?: ComparisonResult;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateComparisonJobInput {
  scope?: ComparisonScope;
  metadataType?: string;
  projectPath: string;
  manifestPath: string;
  leftSource: string;
  rightSource: string;
  strict: boolean;
  showIdentical: boolean;
  createdBy: string;
}

interface ComparisonJobRow {
  id: string;
  status: ComparisonJobStatus;
  scope: ComparisonScope;
  metadata_type: string | null;
  project_path: string;
  manifest_path: string;
  left_source: string;
  right_source: string;
  strict: number;
  show_identical: number;
  created_by: string;
  run_directory: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export class ComparisonJobRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
    private readonly onChanged?: (job: ComparisonJob) => void,
  ) {}

  public async create(input: CreateComparisonJobInput): Promise<ComparisonJob> {
    const id = this.createId();
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async (transaction) => {
      await transaction.run(`
        INSERT INTO comparison_jobs (
          id, status, scope, metadata_type, project_path, manifest_path, left_source, right_source,
          strict, show_identical, created_by, created_at, updated_at
        ) VALUES (?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, input.scope ?? 'MANIFEST', input.metadataType ?? null,
      input.projectPath, input.manifestPath, input.leftSource, input.rightSource,
      input.strict ? 1 : 0, input.showIdentical ? 1 : 0, input.createdBy, timestamp, timestamp);
      await this.writeAudit(transaction, input.createdBy, 'COMPARISON_QUEUED', id, {
        left: input.leftSource,
        right: input.rightSource,
      }, timestamp);
    });
    return this.notify(await this.getRequired(id));
  }

  public async get(id: string): Promise<ComparisonJob | undefined> {
    const row = await this.database.get<ComparisonJobRow>('SELECT * FROM comparison_jobs WHERE id = ?', id);
    return row === undefined ? undefined : mapRow(row);
  }

  public async getRequired(id: string): Promise<ComparisonJob> {
    const job = await this.get(id);
    if (job === undefined) throw new Error(`비교 작업을 찾을 수 없습니다: ${id}`);
    return job;
  }

  public async markRunning(id: string): Promise<void> {
    const timestamp = this.now();
    const result = await this.database.run(`
      UPDATE comparison_jobs SET status = 'RUNNING', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'QUEUED'
    `, timestamp, timestamp, id);
    if (result.changes !== 1) throw new Error(`실행할 수 없는 비교 작업입니다: ${id}`);
    this.notify(await this.getRequired(id));
  }

  public async markSucceeded(id: string, resultValue: ComparisonResult, runDirectory: string): Promise<void> {
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async (transaction) => {
      const result = await transaction.run(`
        UPDATE comparison_jobs
        SET status = 'SUCCEEDED', result_json = ?, run_directory = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `, JSON.stringify(resultValue), runDirectory, timestamp, timestamp, id);
      if (result.changes !== 1) throw new Error(`완료할 수 없는 비교 작업입니다: ${id}`);
      const job = await getRequired(transaction, id);
      await this.writeAudit(transaction, job.createdBy, 'COMPARISON_SUCCEEDED', id, { ...resultValue.summary }, timestamp);
    });
    this.notify(await this.getRequired(id));
  }

  public async markFailed(id: string, code: string, message: string): Promise<void> {
    const timestamp = this.now();
    let changed = false;
    await runInImmediateTransaction(this.database, async (transaction) => {
      const result = await transaction.run(`
        UPDATE comparison_jobs
        SET status = 'FAILED', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('QUEUED', 'RUNNING')
      `, code, message, timestamp, timestamp, id);
      if (result.changes !== 1) return;
      changed = true;
      const job = await getRequired(transaction, id);
      await this.writeAudit(transaction, job.createdBy, 'COMPARISON_FAILED', id, { code }, timestamp);
    });
    if (changed) this.notify(await this.getRequired(id));
  }

  public async recoverInterrupted(): Promise<number> {
    const timestamp = this.now();
    const result = await this.database.run(`
      UPDATE comparison_jobs
      SET status = 'FAILED', error_code = 'PROCESS_INTERRUPTED',
          error_message = '프로세스 재시작으로 비교 작업이 중단되었습니다.',
          updated_at = ?, completed_at = ?
      WHERE status IN ('QUEUED', 'RUNNING')
    `, timestamp, timestamp);
    return result.changes ?? 0;
  }

  public async listRecent(limit = 30): Promise<ComparisonJob[]> {
    return (await this.database.all<ComparisonJobRow[]>(`
      SELECT * FROM comparison_jobs ORDER BY created_at DESC, id DESC LIMIT ?
    `, Math.min(Math.max(limit, 1), 100))).map(mapRow);
  }

  private notify(job: ComparisonJob): ComparisonJob {
    this.onChanged?.(job);
    return job;
  }

  private async writeAudit(
    database: DatabaseHandle,
    actorUserId: string,
    eventType: string,
    entityId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    await database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, 'COMPARISON_JOB', ?, ?, ?)
    `, actorUserId, eventType, entityId, JSON.stringify(detail), timestamp);
  }
}

async function getRequired(database: DatabaseHandle, id: string): Promise<ComparisonJob> {
  const row = await database.get<ComparisonJobRow>('SELECT * FROM comparison_jobs WHERE id = ?', id);
  if (row === undefined) throw new Error(`비교 작업을 찾을 수 없습니다: ${id}`);
  return mapRow(row);
}

function mapRow(row: ComparisonJobRow): ComparisonJob {
  return {
    id: row.id,
    status: row.status,
    scope: row.scope,
    ...(row.metadata_type === null ? {} : { metadataType: row.metadata_type }),
    projectPath: row.project_path,
    manifestPath: row.manifest_path,
    leftSource: row.left_source,
    rightSource: row.right_source,
    strict: row.strict === 1,
    showIdentical: row.show_identical === 1,
    createdBy: row.created_by,
    ...(row.run_directory === null ? {} : { runDirectory: row.run_directory }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as ComparisonResult }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}
