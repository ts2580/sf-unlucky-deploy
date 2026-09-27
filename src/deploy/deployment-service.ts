import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, sha256DirectoryV2 } from '../core/files.js';
import { SfudError } from '../core/errors.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import {
  isAmbiguousSalesforceFailure,
  redactSensitiveText,
  sanitizeSfOutput,
  type SfClient,
} from '../salesforce/sf-client.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import type { OrgExecutionAccessRepository } from '../storage/org-execution-access-repository.js';
import { DeploymentCoordinator, ReconciliationRequiredError } from './deployment-coordinator.js';
import { DeploymentJobRepository, type DeploymentJob } from './deployment-job-repository.js';
import { ExternalDeploymentStateUnknownError, reportSalesforceDeployment, runAsyncSalesforceDeployment } from './salesforce-deployment.js';
import { assertDeploymentOrgIdentities } from './org-identity-verifier.js';
import { sameOrgIdentity } from './org-identity.js';
import { evaluateQuickDeployEligibility } from './quick-deploy-eligibility.js';

export interface ApproveDeploymentRequest {
  dryRunJobId: string;
  approvedBy: string;
  payloadChecksum: string;
  targetAlias: string;
  confirmation: string;
}

export interface DeploymentServiceOptions {
  /** Disables only new Quick Deploy submissions; tracked attempts remain reconcilable. */
  quickDeployEnabled?: boolean;
}

interface StoredSnapshot {
  packageRoot?: unknown;
  payloadSha256?: unknown;
  payloadDigestVersion?: unknown;
}

export class DeploymentService {
  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly coordinator: DeploymentCoordinator,
    private readonly workspace: WorkspaceService,
    private readonly sfClient: SfClient,
    private readonly options: DeploymentServiceOptions = {},
    private readonly orgExecutionAccess?: OrgExecutionAccessRepository,
  ) {}

  public async approveAndExecute(input: ApproveDeploymentRequest): Promise<DeploymentJob> {
    this.coordinator.assertAccepting();
    await this.orgExecutionAccess?.assertCanExecute(input.targetAlias, input.approvedBy);
    const job = await this.jobs.approveAndQueueDeployment(input);
    void this.coordinator.runDeployment(job.id, async (signal) => {
      const persistenceWarnings: string[] = [];
      let attemptId: string | undefined;
      try {
        const current = await this.jobs.getRequiredSummary(job.id);
        const dryRun = await this.jobs.getRequired(requiredString(current.dryRunJobId, 'dry-run 작업'));
        await this.jobs.assertApprovalFresh(dryRun.id);
        const packageRoot = await this.resolvePreparedPackageRoot(dryRun);
        const actualChecksum = await sha256DirectoryV2(packageRoot);
        if (actualChecksum !== current.payloadChecksum) {
          throw new SfudError(
            'PAYLOAD_CHANGED',
            `dry-run 이후 payload checksum이 변경되어 배포를 중단했습니다. expected=${current.payloadChecksum} actual=${actualChecksum}`,
          );
        }
        const testPlan = dryRun.testPlan;
        if (testPlan === undefined) throw new SfudError('INVALID_JOB_STATE', 'dry-run 테스트 계획이 없습니다.');
        const validationAttempt = await this.jobs.attempts.current(dryRun.id);
        const eligibility = evaluateQuickDeployEligibility({
          dryRun,
          deploy: current,
          ...(validationAttempt === undefined ? {} : { validationAttempt }),
        });
        const quickDeployDisabled = eligibility.mode === 'QUICK_DEPLOY' && this.options.quickDeployEnabled === false;
        const executionReasons = quickDeployDisabled
          ? ['운영 제어에서 Quick Deploy 신규 제출을 비활성화했습니다. 기존 Salesforce attempt는 재확인할 수 있습니다.']
          : eligibility.reasons;
        await this.jobs.recordExecutionPlan({
          id: current.id,
          mode: quickDeployDisabled ? 'REVALIDATION_REQUIRED' : eligibility.mode,
          reasons: executionReasons,
          ...(eligibility.validationId === undefined ? {} : { validationId: eligibility.validationId }),
        });
        if (quickDeployDisabled) {
          throw new SfudError('APPROVAL_DENIED', executionReasons[0]!);
        }
        if (eligibility.mode === 'RECONCILE_REQUIRED') {
          throw new ReconciliationRequiredError(eligibility.reasons.join(' '));
        }
        if (eligibility.mode === 'REVALIDATION_REQUIRED') {
          throw new SfudError('APPROVAL_DENIED', `Quick Deploy 재사용 조건이 충족되지 않았습니다. ${eligibility.reasons.join(' ')}`);
        }
        const quickDeploy = eligibility.mode === 'QUICK_DEPLOY';
        const result = await withRequestWorkspace(this.workspace.defaultProject().realPath, async (cwd) =>
          sanitizeSfOutput(await runAsyncSalesforceDeployment({
            sfClient: this.sfClient,
            startArgs: quickDeploy
              ? ['project', 'deploy', 'quick', '--job-id', eligibility.validationId!, '--target-org', current.targetAlias]
              : [
                'project', 'deploy', 'start',
                '--target-org', current.targetAlias,
                '--metadata-dir', packageRoot,
                '--test-level', testPlan.level,
                ...testPlan.tests.flatMap((testName) => ['--tests', testName]),
              ],
            targetAlias: current.targetAlias,
            cwd,
            phase: 'DEPLOY',
            signal,
            beforeSubmit: async () => {
              await this.jobs.assertAccess(current.id, requiredString(current.createdBy, '배포 실행 사용자'));
              await this.orgExecutionAccess?.assertCanExecute(current.targetAlias, requiredString(current.createdBy, '배포 실행 사용자'));
              await assertDeploymentOrgIdentities(current, this.jobs, this.workspace);
              attemptId = await this.jobs.attempts.begin({
                jobId: current.id, operation: quickDeploy ? 'QUICK_DEPLOY' : 'DEPLOY', payloadChecksum: actualChecksum,
                digestVersion: 2, runDirectory: requiredString(dryRun.runDirectory, 'dry-run 실행 디렉터리'),
                ...(quickDeploy ? { validationId: eligibility.validationId! } : {}),
              });
            },
            onSubmitted: async (deploymentId) => {
              await this.jobs.recordSalesforceSubmission(current.id, deploymentId, attemptId);
            },
            onProgress: async (progress) => { await this.jobs.recordSalesforceProgress(current.id, progress, attemptId); },
            onPersistenceError: (stage, error) => {
              persistenceWarnings.push(persistenceWarning(stage, error));
            },
          })));
        const deploymentId = extractDeploymentId(result);
        const attempt = await this.jobs.attempts.current(current.id);
        try {
          await this.jobs.recordDeploymentResult(current.id, result);
        } catch (error) {
          persistenceWarnings.push(persistenceWarning('artifacts', error));
        }
        return {
          ...(deploymentId === undefined ? {} : { deploymentId }),
          ...(attempt === undefined ? {} : { attemptId: attempt.id, attemptVersion: attempt.version }),
          ...(persistenceWarnings.length === 0
            ? {}
            : { persistenceWarning: persistenceWarnings.join(' ') }),
        };
      } catch (error) {
        if ((error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN')
          || isAmbiguousSalesforceFailure(error)) {
          const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
          throw new ReconciliationRequiredError(message, error instanceof ExternalDeploymentStateUnknownError ? error.deploymentId : undefined, { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }).catch(() => undefined);
    return job;
  }

  public async reconcile(jobId: string, actorUserId: string): Promise<DeploymentJob> {
    return await this.reconcileRecordedAttempt(jobId, actorUserId, false);
  }

  public async bindUnknownAttemptAndReconcile(input: {
    jobId: string;
    actorUserId: string;
    deploymentId: string;
    operation: 'VALIDATE' | 'DEPLOY' | 'QUICK_DEPLOY';
    observedAt: string;
    evidence: string;
  }): Promise<DeploymentJob> {
    await this.jobs.assertAdministrator(input.actorUserId);
    if (!/^0Af[A-Za-z0-9]{12,15}$/u.test(input.deploymentId)) {
      throw new SfudError('INVALID_ARGUMENT', 'Salesforce deployment ID 형식이 올바르지 않습니다.');
    }
    if (input.evidence.trim().length < 24 || input.evidence.length > 2_000) {
      throw new SfudError('INVALID_ARGUMENT', '원격 ID 연결 근거는 24자 이상 2,000자 이하여야 합니다.');
    }
    const job = await this.jobs.getRequired(input.jobId);
    const attempt = await this.jobs.attempts.current(input.jobId);
    if (job.status !== 'RECONCILE_REQUIRED' || attempt === undefined
      || attempt.operation !== input.operation || attempt.submissionState !== 'SUBMITTING'
      || attempt.validationId !== undefined || attempt.deploymentId !== undefined) {
      throw new SfudError('INVALID_JOB_STATE', '관리자 연결 대상인 ID 없는 Salesforce 제출이 아닙니다.');
    }
    await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
    const target = await this.workspace.getOrgIdentity(job.targetAlias, true);
    if (target === undefined || job.targetOrgIdentity === undefined
      || !sameOrgIdentity(job.targetOrgIdentity, target)) {
      throw new SfudError('ORG_IDENTITY_CHANGED', '대상 org identity를 재확인하지 못해 원격 ID를 연결하지 않았습니다.');
    }
    assertObservationTime(input.observedAt, attempt.startedAt);
    const phase = input.operation === 'VALIDATE' ? 'DRY_RUN' : 'DEPLOY';
    const confirmation = await withRequestWorkspace(this.workspace.defaultProject().realPath, async (cwd) =>
      reportSalesforceDeployment({
        sfClient: this.sfClient, deploymentId: input.deploymentId, targetAlias: job.targetAlias, cwd, phase,
      }));
    if (confirmation.reportedDeploymentId !== input.deploymentId
      || confirmation.progress.checkOnly !== (input.operation === 'VALIDATE')) {
      throw new SfudError('INVALID_JOB_STATE', '원격 report가 입력한 실행 ID 또는 제출 유형을 명시적으로 확인하지 않았습니다.');
    }
    await this.jobs.attempts.bindForReconciliation({
      jobId: input.jobId, attemptId: attempt.id, operation: input.operation, deploymentId: input.deploymentId,
      actorUserId: input.actorUserId, observedAt: input.observedAt, evidence: input.evidence.trim(),
    });
    return await this.reconcileRecordedAttempt(input.jobId, input.actorUserId, true);
  }

  private async reconcileRecordedAttempt(
    jobId: string,
    actorUserId: string,
    administratorOverride: boolean,
  ): Promise<DeploymentJob> {
    if (administratorOverride) await this.jobs.assertAdministrator(actorUserId);
    else await this.jobs.assertAccess(jobId, actorUserId);
    const job = await this.jobs.getRequired(jobId);
    const attempt = await this.jobs.attempts.current(jobId);
    const validation = attempt?.operation === 'VALIDATE';
    const remoteId = attempt === undefined ? job.salesforceDeploymentId
      : validation ? attempt.validationId : attempt.deploymentId;
    if (job.status !== 'RECONCILE_REQUIRED' || remoteId === undefined) {
      throw new SfudError('INVALID_JOB_STATE', 'Salesforce 상태를 재확인할 수 있는 작업이 아닙니다.');
    }
    await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
    const result = await withRequestWorkspace(this.workspace.defaultProject().realPath, async (cwd) =>
      reportSalesforceDeployment({
        sfClient: this.sfClient,
        deploymentId: remoteId,
        targetAlias: job.targetAlias,
        cwd,
        phase: validation || (attempt === undefined && job.kind === 'DRY_RUN') ? 'DRY_RUN' : 'DEPLOY',
      }));
    const expectedCheckOnly = validation || (attempt === undefined && job.kind === 'DRY_RUN');
    if ((result.progress.checkOnly !== undefined && result.progress.checkOnly !== expectedCheckOnly)
      || (attempt === undefined && result.progress.checkOnly === undefined)) {
      throw new SfudError('INVALID_JOB_STATE', '원격 보고서의 검증/실제 배포 유형을 확인할 수 없습니다. 재확인 상태를 유지합니다.');
    }
    const persistenceWarning = job.kind === 'DRY_RUN' && result.progress.done
      && result.progress.success !== false && !job.prepared
      ? '원격 dry-run은 성공했지만 고정 payload artifact가 없어 dry-run을 다시 실행해야 합니다.'
      : undefined;
    let reconciled = await this.jobs.recordReconciliationReport({
      id: job.id,
      actorUserId,
      report: result.report,
      progress: result.progress,
      ...(attempt === undefined ? {} : { attemptId: attempt.id, attemptVersion: attempt.version }),
      ...(persistenceWarning === undefined ? {} : { persistenceWarning }),
    });
    if (!result.progress.done) return reconciled;
    if (result.progress.success === false
      || !['Succeeded', 'SucceededPartial'].includes(result.progress.status)) {
      return await this.jobs.transition(job.id, 'FAILED', {
        remoteStatus: 'FAILED',
        errorCode: 'REMOTE_DEPLOYMENT_FAILED',
        errorMessage: `Salesforce 배포가 ${result.progress.status} 상태로 종료되었습니다.`,
      });
    }
    if (job.kind === 'DRY_RUN' && !job.prepared) return reconciled;
    reconciled = await this.jobs.transition(
      job.id,
      job.kind === 'DRY_RUN' ? 'APPROVAL_PENDING' : validation ? 'VALIDATED_PENDING_EXECUTION' : 'SUCCEEDED',
      { remoteStatus: 'SUCCEEDED' },
    );
    return reconciled;
  }

  private async resolvePreparedPackageRoot(dryRun: DeploymentJob): Promise<string> {
    if (!dryRun.prepared || dryRun.runDirectory === undefined) {
      throw new SfudError('INVALID_JOB_STATE', 'dry-run payload 준비가 완료되지 않았습니다.');
    }
    const snapshotPath = await firstExistingPath([
      path.join(dryRun.runDirectory, 'deploy-payload', 'snapshot.json'),
      path.join(dryRun.runDirectory, 'right', 'snapshot.json'),
    ]);
    if (snapshotPath === undefined) throw new SfudError('INVALID_JOB_STATE', 'dry-run payload snapshot을 찾을 수 없습니다.');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as StoredSnapshot;
    if (typeof snapshot.packageRoot !== 'string' || typeof snapshot.payloadSha256 !== 'string'
      || snapshot.payloadDigestVersion !== 2) {
      throw new SfudError('INVALID_JOB_STATE', 'dry-run payload snapshot 형식이 올바르지 않습니다.');
    }
    if (snapshot.payloadSha256 !== dryRun.payloadChecksum) {
      throw new SfudError('PAYLOAD_CHANGED', '저장된 dry-run snapshot checksum이 승인 값과 다릅니다.');
    }
    const [runDirectory, packageRoot] = await Promise.all([
      realpath(dryRun.runDirectory),
      realpath(snapshot.packageRoot),
    ]);
    if (!isInside(runDirectory, packageRoot)) {
      throw new SfudError('INVALID_JOB_STATE', 'dry-run payload 경로가 실행 디렉터리 밖을 가리킵니다.');
    }
    return packageRoot;
  }
}

function assertObservationTime(observedAt: string, attemptStartedAt: string): void {
  const observed = Date.parse(observedAt);
  const started = Date.parse(attemptStartedAt);
  const now = Date.now();
  if (!Number.isFinite(observed) || !Number.isFinite(started)
    || observed < started - 10 * 60 * 1_000 || observed > now + 5 * 60 * 1_000) {
    throw new SfudError('INVALID_ARGUMENT', '원격 작업 확인 시각은 제출 attempt 시작 시각 이후여야 합니다.');
  }
}

async function firstExistingPath(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return undefined;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new SfudError('INVALID_JOB_STATE', `${label}이 없습니다.`);
  return value;
}

function persistenceWarning(stage: 'submission' | 'progress' | 'artifacts', error: unknown): string {
  const label = stage === 'submission'
    ? 'Salesforce 배포 ID'
    : stage === 'progress' ? 'Salesforce 진행 상태' : '배포 상세 결과';
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return `${label} 저장 실패: ${message}`;
}

function extractDeploymentId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const result = isRecord(value.result) ? value.result : value;
  for (const key of ['id', 'deployId', 'deploymentId']) {
    if (typeof result[key] === 'string' && result[key].length > 0) return result[key];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
