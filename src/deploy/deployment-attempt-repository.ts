import { randomUUID } from 'node:crypto';

import { SfudError } from '../core/errors.js';
import type { DatabaseExecutor } from '../storage/database-executor.js';
import type { OrgIdentitySnapshot } from './org-identity.js';
import type { SalesforceDeploymentProgress } from './salesforce-deployment.js';

export interface DeploymentAttempt {
  id: string;
  jobId: string;
  operation: 'VALIDATE' | 'DEPLOY' | 'QUICK_DEPLOY';
  submissionState: 'NOT_SUBMITTED' | 'SUBMITTING' | 'SUBMITTED' | 'TERMINAL';
  validationId?: string;
  deploymentId?: string;
  targetOrgIdentity: OrgIdentitySnapshot;
  payloadChecksum: string;
  digestVersion: number;
  startedAt: string;
  remoteStatus: string;
  version: number;
}

interface AttemptRow {
  id: string; job_id: string; operation: DeploymentAttempt['operation'];
  submission_state: DeploymentAttempt['submissionState'];
  validation_id: string | null; deployment_id: string | null;
  target_org_identity_json: string; payload_checksum: string; digest_version: number;
  started_at: string; remote_status: string; version: number;
}

/** 외부 실행 전에 제출 의도와 실행별 식별자를 트랜잭션으로 보존한다. */
export class DeploymentAttemptRepository {
  public constructor(private readonly database: DatabaseExecutor) {}

  public async current(jobId: string): Promise<DeploymentAttempt | undefined> {
    const row = await this.database.get<AttemptRow>(`
      SELECT a.* FROM deployment_attempts a JOIN deployment_jobs j ON j.active_attempt_id = a.id
      WHERE j.id = ?
    `, jobId);
    if (row === undefined) return undefined;
    return {
      id: row.id, jobId: row.job_id, operation: row.operation, submissionState: row.submission_state,
      ...(row.validation_id === null ? {} : { validationId: row.validation_id }),
      ...(row.deployment_id === null ? {} : { deploymentId: row.deployment_id }),
      targetOrgIdentity: JSON.parse(row.target_org_identity_json) as OrgIdentitySnapshot,
      payloadChecksum: row.payload_checksum, digestVersion: row.digest_version,
      startedAt: row.started_at, remoteStatus: row.remote_status, version: row.version,
    };
  }

  public async begin(input: {
    jobId: string; operation: DeploymentAttempt['operation']; payloadChecksum: string;
    digestVersion: number; runDirectory: string; validationId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.transaction(async (transaction) => {
      const job = await transaction.get<{
        status: string; active_attempt_id: string | null; target_org_identity_json: string | null;
        dry_run_job_id: string | null;
      }>('SELECT status, active_attempt_id, target_org_identity_json, dry_run_job_id FROM deployment_jobs WHERE id = ?', input.jobId);
      if (job === undefined || !['DRY_RUN_RUNNING', 'DEPLOYING'].includes(job.status)
        || job.target_org_identity_json === null) {
        throw new SfudError('INVALID_JOB_STATE', '외부 제출 의도를 저장할 수 없는 작업입니다.');
      }
      if (job.active_attempt_id !== null) {
        const previous = await transaction.get<AttemptRow>('SELECT * FROM deployment_attempts WHERE id = ?', job.active_attempt_id);
        // 직접 배포의 검증 → 실제 실행만 같은 job에서 허용한다. 불명확한 실행은 재제출하지 않는다.
        if (previous?.operation !== 'VALIDATE' || previous.submission_state !== 'TERMINAL'
          || previous.remote_status !== 'SUCCEEDED' || input.operation !== 'DEPLOY') {
          throw new SfudError('INVALID_JOB_STATE', '이미 제출했거나 재확인이 필요한 작업입니다.');
        }
      }
      await transaction.run(`
        INSERT INTO deployment_attempts (
          id, job_id, operation, submission_state, validation_id, target_org_identity_json,
          payload_checksum, digest_version, approval_job_id, started_at, remote_status
        ) VALUES (?, ?, ?, 'SUBMITTING', ?, ?, ?, ?, ?, ?, 'UNKNOWN')
      `, id, input.jobId, input.operation, input.validationId ?? null, job.target_org_identity_json,
      input.payloadChecksum, input.digestVersion, job.dry_run_job_id, now);
      await transaction.run(`
        UPDATE deployment_jobs SET active_attempt_id = ?, salesforce_deployment_id = NULL,
          progress_json = NULL, remote_status = 'UNKNOWN', execution_evidence = 'ATTEMPT_TRACKED',
          payload_checksum = ?, run_directory = ?, updated_at = ?
        WHERE id = ?
      `, id, input.payloadChecksum, input.runDirectory, now, input.jobId);
      await transaction.run(`
        INSERT INTO audit_events (event_type, entity_type, entity_id, detail_json, created_at)
        VALUES ('DEPLOYMENT_SUBMISSION_INTENT', 'DEPLOYMENT', ?, ?, ?)
      `, input.jobId, JSON.stringify({ attemptId: id, operation: input.operation,
        payloadChecksum: input.payloadChecksum, digestVersion: input.digestVersion }), now);
    });
    return id;
  }

  public async submitted(jobId: string, attemptId: string, remoteId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const updated = await transaction.run(`
        UPDATE deployment_attempts SET
          validation_id = CASE WHEN operation = 'VALIDATE' THEN ? ELSE validation_id END,
          deployment_id = CASE WHEN operation <> 'VALIDATE' THEN ? ELSE deployment_id END,
          submission_state = 'SUBMITTED', remote_status = 'SUBMITTED', version = version + 1
        WHERE id = ? AND job_id = ? AND submission_state = 'SUBMITTING'
          AND id = (SELECT active_attempt_id FROM deployment_jobs WHERE id = ? AND status IN ('DRY_RUN_RUNNING', 'DEPLOYING'))
      `, remoteId, remoteId, attemptId, jobId, jobId);
      if (updated.changes !== 1) throw new SfudError('INVALID_JOB_STATE', '현재 실행의 제출 응답이 아닙니다.');
      await transaction.run(`UPDATE deployment_jobs SET salesforce_deployment_id = ?, remote_status = 'SUBMITTED', updated_at = ? WHERE id = ?`,
        remoteId, new Date().toISOString(), jobId);
    });
  }

  public async bindForReconciliation(input: {
    jobId: string;
    attemptId: string;
    operation: DeploymentAttempt['operation'];
    deploymentId: string;
    actorUserId: string;
    observedAt: string;
    evidence: string;
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.database.transaction(async (transaction) => {
      const attempt = await transaction.get<AttemptRow>(`
        SELECT a.* FROM deployment_attempts a JOIN deployment_jobs j ON j.active_attempt_id = a.id
        WHERE a.id = ? AND a.job_id = ? AND j.status = 'RECONCILE_REQUIRED'
      `, input.attemptId, input.jobId);
      if (attempt === undefined || attempt.operation !== input.operation
        || attempt.submission_state !== 'SUBMITTING'
        || attempt.validation_id !== null || attempt.deployment_id !== null) {
        throw new SfudError('INVALID_JOB_STATE', '관리자 연결 대상인 ID 없는 제출 attempt가 아닙니다.');
      }
      const changed = await transaction.run(`
        UPDATE deployment_attempts SET
          validation_id = CASE WHEN operation = 'VALIDATE' THEN ? ELSE validation_id END,
          deployment_id = CASE WHEN operation <> 'VALIDATE' THEN ? ELSE deployment_id END,
          submission_state = 'SUBMITTED', remote_status = 'SUBMITTED', version = version + 1
        WHERE id = ? AND version = ?
      `, input.deploymentId, input.deploymentId, input.attemptId, attempt.version);
      if (changed.changes !== 1) throw new SfudError('INVALID_JOB_STATE', '관리자 확인 중 attempt가 변경되었습니다.');
      await transaction.run(`
        UPDATE deployment_jobs SET salesforce_deployment_id = ?, remote_status = 'SUBMITTED', updated_at = ?
        WHERE id = ? AND active_attempt_id = ? AND status = 'RECONCILE_REQUIRED'
      `, input.deploymentId, timestamp, input.jobId, input.attemptId);
      await transaction.run(`
        INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
        VALUES (?, 'DEPLOYMENT_ATTEMPT_MANUALLY_BOUND', 'DEPLOYMENT', ?, ?, ?)
      `, input.actorUserId, input.jobId, JSON.stringify({
        attemptId: input.attemptId,
        operation: input.operation,
        deploymentId: input.deploymentId,
        observedAt: input.observedAt,
        evidence: input.evidence,
      }), timestamp);
    });
  }

  public async progress(jobId: string, attemptId: string, progress: SalesforceDeploymentProgress): Promise<void> {
    const remoteStatus = progress.done
      ? progress.success !== false && ['Succeeded', 'SucceededPartial'].includes(progress.status) ? 'SUCCEEDED' : 'FAILED'
      : 'RUNNING';
    await this.database.transaction(async (transaction) => {
      const updated = await transaction.run(`
        UPDATE deployment_attempts SET
          validation_id = CASE WHEN operation = 'VALIDATE' THEN ? ELSE validation_id END,
          deployment_id = CASE WHEN operation <> 'VALIDATE' THEN ? ELSE deployment_id END,
          submission_state = ?, remote_status = ?, completed_at = ?, version = version + 1
        WHERE id = ? AND job_id = ? AND submission_state IN ('SUBMITTING', 'SUBMITTED')
          AND (CASE WHEN operation = 'VALIDATE' THEN 'DRY_RUN' ELSE 'DEPLOY' END) = ?
          AND (CASE WHEN operation = 'VALIDATE' THEN validation_id ELSE deployment_id END IS NULL
            OR CASE WHEN operation = 'VALIDATE' THEN validation_id ELSE deployment_id END = ?)
          AND id = (SELECT active_attempt_id FROM deployment_jobs WHERE id = ? AND status IN ('DRY_RUN_RUNNING', 'DEPLOYING'))
      `, progress.deploymentId, progress.deploymentId, progress.done ? 'TERMINAL' : 'SUBMITTED', remoteStatus,
      progress.done ? progress.checkedAt : null, attemptId, jobId, progress.phase, progress.deploymentId, jobId);
      if (updated.changes !== 1) throw new SfudError('INVALID_JOB_STATE', '현재 실행의 진행 상태가 아닙니다.');
      await transaction.run(`UPDATE deployment_jobs SET progress_json = ?, salesforce_deployment_id = ?, remote_status = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(progress), progress.deploymentId, remoteStatus, progress.checkedAt, jobId);
    });
  }
}
