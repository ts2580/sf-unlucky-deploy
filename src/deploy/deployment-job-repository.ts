import { randomUUID } from 'node:crypto';

import type { Database } from 'sqlite';

import { SfudError } from '../core/errors.js';
import { runInImmediateTransaction } from '../storage/transaction.js';
import type { ComparisonResult } from '../metadata/comparator.js';
import type { ApexTestPlan } from './test-plan.js';

export type DeploymentJobKind = 'DRY_RUN' | 'DEPLOY';
export type DeploymentScope = 'MANIFEST' | 'ALL';
export type DeploymentJobStatus =
  | 'QUEUED'
  | 'DRY_RUN_RUNNING'
  | 'APPROVAL_PENDING'
  | 'DEPLOYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RECONCILE_REQUIRED';

export interface DeploymentJob {
  id: string;
  kind: DeploymentJobKind;
  status: DeploymentJobStatus;
  source: string;
  targetAlias: string;
  manifestPath: string;
  scope: DeploymentScope;
  metadataType?: string;
  payloadChecksum: string;
  runDirectory?: string;
  salesforceDeploymentId?: string;
  dryRunJobId?: string;
  createdBy?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  prepared: boolean;
  comparisonResult?: ComparisonResult;
  testPlan?: ApexTestPlan;
  dryRunResult?: unknown;
}

export interface CreateDryRunJobInput {
  source: string;
  targetAlias: string;
  manifestPath: string;
  scope?: DeploymentScope;
  metadataType?: string;
  payloadChecksum: string;
  runDirectory?: string;
  createdBy?: string;
}

export interface TransitionDetails {
  salesforceDeploymentId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ApproveDeploymentInput {
  dryRunJobId: string;
  approvedBy: string;
  payloadChecksum: string;
  targetAlias: string;
  confirmation: string;
}

interface DeploymentJobRow {
  id: string;
  kind: DeploymentJobKind;
  status: DeploymentJobStatus;
  source: string;
  target_alias: string;
  manifest_path: string;
  scope: DeploymentScope;
  metadata_type: string | null;
  payload_checksum: string;
  run_directory: string | null;
  salesforce_deployment_id: string | null;
  dry_run_job_id: string | null;
  created_by: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  is_prepared: number;
  comparison_result_json: string | null;
  test_plan_json: string | null;
  dry_run_result_json: string | null;
}

const ALLOWED_TRANSITIONS: Record<DeploymentJobStatus, ReadonlySet<DeploymentJobStatus>> = {
  QUEUED: new Set(['DRY_RUN_RUNNING', 'DEPLOYING', 'FAILED']),
  DRY_RUN_RUNNING: new Set(['APPROVAL_PENDING', 'FAILED', 'RECONCILE_REQUIRED']),
  APPROVAL_PENDING: new Set(),
  DEPLOYING: new Set(['SUCCEEDED', 'FAILED', 'RECONCILE_REQUIRED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  RECONCILE_REQUIRED: new Set(['SUCCEEDED', 'FAILED']),
};

export class DeploymentJobRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public async createDryRun(input: CreateDryRunJobInput): Promise<DeploymentJob> {
    assertChecksum(input.payloadChecksum);
    const id = this.createId();
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async () => {
      await this.database.run(`
        INSERT INTO deployment_jobs (
          id, kind, status, source, target_alias, manifest_path, scope, metadata_type, payload_checksum,
          run_directory, created_by, created_at, updated_at
        ) VALUES (?, 'DRY_RUN', 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        id,
        input.source,
        input.targetAlias,
        input.manifestPath,
        input.scope ?? 'MANIFEST',
        input.metadataType ?? null,
        input.payloadChecksum,
        input.runDirectory ?? null,
        input.createdBy ?? null,
        timestamp,
        timestamp,
      );
      await this.writeAudit(input.createdBy, 'DRY_RUN_QUEUED', id, {
        targetAlias: input.targetAlias,
        payloadChecksum: input.payloadChecksum,
      }, timestamp);
    });
    return this.getRequired(id);
  }

  public async get(id: string): Promise<DeploymentJob | undefined> {
    const row = await this.database.get<DeploymentJobRow>(
      'SELECT * FROM deployment_jobs WHERE id = ?',
      id,
    );
    return row === undefined ? undefined : mapDeploymentJob(row);
  }

  public async getRequired(id: string): Promise<DeploymentJob> {
    const job = await this.get(id);
    if (job === undefined) {
      throw new SfudError('INVALID_ARGUMENT', `배포 작업을 찾을 수 없습니다: ${id}`);
    }
    return job;
  }

  public async transition(
    id: string,
    nextStatus: DeploymentJobStatus,
    details: TransitionDetails = {},
  ): Promise<DeploymentJob> {
    await runInImmediateTransaction(this.database, async () => {
      const current = await this.getRequired(id);
      assertTransition(current, nextStatus);
      const timestamp = this.now();
      const startedAt = nextStatus === 'DRY_RUN_RUNNING' || nextStatus === 'DEPLOYING'
        ? timestamp
        : current.startedAt ?? null;
      const completedAt = nextStatus === 'APPROVAL_PENDING' || nextStatus === 'SUCCEEDED' || nextStatus === 'FAILED'
        ? timestamp
        : null;
      const result = await this.database.run(`
        UPDATE deployment_jobs
        SET status = ?, updated_at = ?, started_at = ?, completed_at = ?,
            salesforce_deployment_id = COALESCE(?, salesforce_deployment_id),
            error_code = ?, error_message = ?
        WHERE id = ? AND status = ?
      `,
        nextStatus,
        timestamp,
        startedAt,
        completedAt,
        details.salesforceDeploymentId ?? null,
        details.errorCode ?? null,
        details.errorMessage ?? null,
        id,
        current.status,
      );
      if (result.changes !== 1) {
        throw new SfudError('INVALID_JOB_STATE', `배포 작업 상태가 동시에 변경되었습니다: ${id}`);
      }
      await this.writeAudit(current.createdBy, 'DEPLOYMENT_STATUS_CHANGED', id, {
        from: current.status,
        to: nextStatus,
        ...(details.salesforceDeploymentId === undefined
          ? {}
          : { salesforceDeploymentId: details.salesforceDeploymentId }),
        ...(details.errorCode === undefined ? {} : { errorCode: details.errorCode }),
      }, timestamp);
    });
    return this.getRequired(id);
  }

  public async recordDryRunArtifacts(input: {
    id: string;
    payloadChecksum: string;
    runDirectory: string;
    comparisonResult: ComparisonResult;
    testPlan: ApexTestPlan;
    dryRunResult: unknown;
  }): Promise<void> {
    assertChecksum(input.payloadChecksum);
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async () => {
      const result = await this.database.run(`
        UPDATE deployment_jobs
        SET payload_checksum = ?, run_directory = ?, is_prepared = 1,
            comparison_result_json = ?, test_plan_json = ?, dry_run_result_json = ?, updated_at = ?
        WHERE id = ? AND kind = 'DRY_RUN' AND status = 'DRY_RUN_RUNNING' AND is_prepared = 0
      `,
      input.payloadChecksum,
      input.runDirectory,
      JSON.stringify(input.comparisonResult),
      JSON.stringify(input.testPlan),
      JSON.stringify(input.dryRunResult),
      timestamp,
      input.id);
      if (result.changes !== 1) {
        throw new SfudError('INVALID_JOB_STATE', 'dry-run 결과를 기록할 수 없는 작업 상태입니다.');
      }
      const job = await this.getRequired(input.id);
      await this.writeAudit(job.createdBy, 'DRY_RUN_ARTIFACTS_RECORDED', input.id, {
        payloadChecksum: input.payloadChecksum,
        testLevel: input.testPlan.level,
        different: input.comparisonResult.summary.different,
      }, timestamp);
    });
  }

  public async approveAndQueueDeployment(input: ApproveDeploymentInput): Promise<DeploymentJob> {
    if (input.confirmation !== '실제 배포') {
      throw new SfudError('APPROVAL_DENIED', '실제 배포 확인 문구가 일치하지 않습니다.');
    }
    assertChecksum(input.payloadChecksum);

    let deployJobId = '';
    try {
      await runInImmediateTransaction(this.database, async () => {
        const dryRun = await this.getRequired(input.dryRunJobId);
        if (dryRun.kind !== 'DRY_RUN' || dryRun.status !== 'APPROVAL_PENDING') {
          throw new SfudError('APPROVAL_DENIED', '승인 가능한 성공한 dry-run 작업이 아닙니다.');
        }
        if (dryRun.payloadChecksum !== input.payloadChecksum) {
          throw new SfudError('PAYLOAD_CHANGED', 'dry-run 이후 payload checksum이 변경되었습니다.');
        }
        if (dryRun.targetAlias !== input.targetAlias) {
          throw new SfudError('APPROVAL_DENIED', '승인 대상 org 별칭이 dry-run 대상과 일치하지 않습니다.');
        }
        if (!dryRun.prepared) {
          throw new SfudError('APPROVAL_DENIED', 'payload 준비가 완료되지 않은 dry-run 작업입니다.');
        }

        const approver = await this.database.get<{ role: string; disabled_at: string | null }>(
          'SELECT role, disabled_at FROM users WHERE id = ?',
          input.approvedBy,
        );
        if (
          approver === undefined
          || approver.disabled_at !== null
          || !['DEPLOYER', 'ADMIN'].includes(approver.role)
        ) {
          throw new SfudError('APPROVAL_DENIED', '실제 배포 승인 권한이 없습니다.');
        }
        const existingApproval = await this.database.get<{ existing: number }>(
          'SELECT 1 existing FROM deployment_approvals WHERE dry_run_job_id = ?',
          dryRun.id,
        );
        if (existingApproval !== undefined) {
          throw new SfudError('APPROVAL_DENIED', '이미 실제 배포가 승인된 dry-run 작업입니다.');
        }

        const timestamp = this.now();
        deployJobId = this.createId();
        await this.database.run(`
        INSERT INTO deployment_jobs (
          id, kind, status, source, target_alias, manifest_path, scope, metadata_type, payload_checksum,
          run_directory, dry_run_job_id, created_by, created_at, updated_at
        ) VALUES (?, 'DEPLOY', 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        deployJobId,
        dryRun.source,
        dryRun.targetAlias,
        dryRun.manifestPath,
        dryRun.scope,
        dryRun.metadataType ?? null,
        dryRun.payloadChecksum,
        dryRun.runDirectory ?? null,
        dryRun.id,
        input.approvedBy,
        timestamp,
        timestamp,
      );
        await this.database.run(`
        INSERT INTO deployment_approvals (
          id, dry_run_job_id, deploy_job_id, approved_by,
          payload_checksum, target_alias, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        this.createId(),
        dryRun.id,
        deployJobId,
        input.approvedBy,
        dryRun.payloadChecksum,
        dryRun.targetAlias,
        timestamp,
      );
        await this.writeAudit(input.approvedBy, 'DEPLOYMENT_APPROVED', deployJobId, {
          dryRunJobId: dryRun.id,
          targetAlias: dryRun.targetAlias,
          payloadChecksum: dryRun.payloadChecksum,
        }, timestamp);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SfudError('APPROVAL_DENIED', '이미 실제 배포가 승인된 dry-run 작업입니다.');
      }
      throw error;
    }
    return this.getRequired(deployJobId);
  }

  public async recoverInterruptedJobs(): Promise<number> {
    const interrupted = await this.database.all<Array<{ id: string; status: DeploymentJobStatus }>>(`
      SELECT id, status FROM deployment_jobs
      WHERE status IN ('QUEUED', 'DRY_RUN_RUNNING', 'DEPLOYING')
      ORDER BY created_at
    `);
    for (const job of interrupted) {
      if (job.status === 'QUEUED') {
        await this.transition(job.id, 'FAILED', {
          errorCode: 'PROCESS_INTERRUPTED_BEFORE_START',
          errorMessage: '프로세스 재시작 전에 작업을 시작하지 못했습니다.',
        });
      } else {
        await this.transition(job.id, 'RECONCILE_REQUIRED', {
          errorCode: 'PROCESS_INTERRUPTED',
          errorMessage: '프로세스 재시작 후 Salesforce 상태 재확인이 필요합니다.',
        });
      }
    }
    return interrupted.length;
  }

  public async listQueued(): Promise<DeploymentJob[]> {
    return (await this.database.all<DeploymentJobRow[]>(`
      SELECT * FROM deployment_jobs WHERE status = 'QUEUED' ORDER BY created_at, id
    `)).map(mapDeploymentJob);
  }

  public async listRecent(limit = 50): Promise<DeploymentJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new SfudError('INVALID_ARGUMENT', '조회 개수는 1부터 200 사이여야 합니다.');
    }
    return (await this.database.all<DeploymentJobRow[]>(`
      SELECT * FROM deployment_jobs ORDER BY created_at DESC, id DESC LIMIT ?
    `, limit)).map(mapDeploymentJob);
  }

  private async writeAudit(
    actorUserId: string | undefined,
    eventType: string,
    entityId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): Promise<void> {
    await this.database.run(`
      INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, 'DEPLOYMENT_JOB', ?, ?, ?)
    `, actorUserId ?? null, eventType, entityId, JSON.stringify(detail), timestamp);
  }
}

function assertTransition(job: DeploymentJob, nextStatus: DeploymentJobStatus): void {
  if (!ALLOWED_TRANSITIONS[job.status].has(nextStatus)) {
    throw new SfudError(
      'INVALID_JOB_STATE',
      `허용되지 않은 배포 상태 전이입니다: ${job.status} → ${nextStatus}`,
    );
  }
  if (job.kind === 'DRY_RUN' && nextStatus === 'DEPLOYING') {
    throw new SfudError('INVALID_JOB_STATE', 'dry-run 작업은 DEPLOYING 상태로 전이할 수 없습니다.');
  }
  if (job.kind === 'DEPLOY' && nextStatus === 'DRY_RUN_RUNNING') {
    throw new SfudError('INVALID_JOB_STATE', '실제 배포 작업은 DRY_RUN_RUNNING 상태로 전이할 수 없습니다.');
  }
}

function assertChecksum(value: string): void {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new SfudError('INVALID_ARGUMENT', 'payload checksum은 64자리 SHA-256이어야 합니다.');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
}

function mapDeploymentJob(row: DeploymentJobRow): DeploymentJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    source: row.source,
    targetAlias: row.target_alias,
    manifestPath: row.manifest_path,
    scope: row.scope,
    ...(row.metadata_type === null ? {} : { metadataType: row.metadata_type }),
    payloadChecksum: row.payload_checksum,
    ...(row.run_directory === null ? {} : { runDirectory: row.run_directory }),
    ...(row.salesforce_deployment_id === null
      ? {}
      : { salesforceDeploymentId: row.salesforce_deployment_id }),
    ...(row.dry_run_job_id === null ? {} : { dryRunJobId: row.dry_run_job_id }),
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    prepared: row.is_prepared === 1,
    ...(row.comparison_result_json === null
      ? {}
      : { comparisonResult: JSON.parse(row.comparison_result_json) as ComparisonResult }),
    ...(row.test_plan_json === null ? {} : { testPlan: JSON.parse(row.test_plan_json) as ApexTestPlan }),
    ...(row.dry_run_result_json === null ? {} : { dryRunResult: JSON.parse(row.dry_run_result_json) as unknown }),
  };
}
