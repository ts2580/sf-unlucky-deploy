import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { pathExists, sha256Directory } from '../core/files.js';
import { SfudError } from '../core/errors.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import {
  isAmbiguousSalesforceFailure,
  redactSensitiveText,
  sanitizeSfOutput,
  type SfClient,
} from '../salesforce/sf-client.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import { DeploymentCoordinator, ReconciliationRequiredError } from './deployment-coordinator.js';
import { DeploymentJobRepository, type DeploymentJob } from './deployment-job-repository.js';
import { reportSalesforceDeployment, runAsyncSalesforceDeployment } from './salesforce-deployment.js';
import { assertDeploymentOrgIdentities } from './org-identity-verifier.js';

export interface ApproveDeploymentRequest {
  dryRunJobId: string;
  approvedBy: string;
  payloadChecksum: string;
  targetAlias: string;
  confirmation: string;
}

interface StoredSnapshot {
  packageRoot?: unknown;
  payloadSha256?: unknown;
}

export class DeploymentService {
  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly coordinator: DeploymentCoordinator,
    private readonly workspace: WorkspaceService,
    private readonly sfClient: SfClient,
  ) {}

  public async approveAndExecute(input: ApproveDeploymentRequest): Promise<DeploymentJob> {
    this.coordinator.assertAccepting();
    const job = await this.jobs.approveAndQueueDeployment(input);
    void this.coordinator.runDeployment(job.id, async (signal) => {
      const persistenceWarnings: string[] = [];
      try {
        const current = await this.jobs.getRequired(job.id);
        const dryRun = await this.jobs.getRequired(requiredString(current.dryRunJobId, 'dry-run 작업'));
        const packageRoot = await this.resolvePreparedPackageRoot(dryRun);
        const actualChecksum = await sha256Directory(packageRoot);
        if (actualChecksum !== current.payloadChecksum) {
          throw new SfudError(
            'PAYLOAD_CHANGED',
            `dry-run 이후 payload checksum이 변경되어 배포를 중단했습니다. expected=${current.payloadChecksum} actual=${actualChecksum}`,
          );
        }
        const testPlan = dryRun.testPlan;
        if (testPlan === undefined) throw new SfudError('INVALID_JOB_STATE', 'dry-run 테스트 계획이 없습니다.');
        const result = await withRequestWorkspace(this.workspace.defaultProject().realPath, async (cwd) =>
          sanitizeSfOutput(await runAsyncSalesforceDeployment({
            sfClient: this.sfClient,
            startArgs: [
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
              await assertDeploymentOrgIdentities(current, this.jobs, this.workspace);
            },
            onSubmitted: async (deploymentId) => {
              await this.jobs.recordSalesforceSubmission(current.id, deploymentId);
            },
            onProgress: async (progress) => { await this.jobs.recordSalesforceProgress(current.id, progress); },
            onPersistenceError: (stage, error) => {
              persistenceWarnings.push(persistenceWarning(stage, error));
            },
          })));
        const deploymentId = extractDeploymentId(result);
        try {
          await this.jobs.recordDeploymentResult(current.id, result);
        } catch (error) {
          persistenceWarnings.push(persistenceWarning('artifacts', error));
        }
        return {
          ...(deploymentId === undefined ? {} : { deploymentId }),
          ...(persistenceWarnings.length === 0
            ? {}
            : { persistenceWarning: persistenceWarnings.join(' ') }),
        };
      } catch (error) {
        if ((error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN')
          || isAmbiguousSalesforceFailure(error)) {
          const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
          throw new ReconciliationRequiredError(message, extractDeploymentIdFromText(message), { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }).catch(() => undefined);
    return job;
  }

  public async reconcile(jobId: string, actorUserId: string): Promise<DeploymentJob> {
    const job = await this.jobs.getRequired(jobId);
    if (job.status !== 'RECONCILE_REQUIRED' || job.salesforceDeploymentId === undefined) {
      throw new SfudError('INVALID_JOB_STATE', 'Salesforce 상태를 재확인할 수 있는 작업이 아닙니다.');
    }
    await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
    const result = await withRequestWorkspace(this.workspace.defaultProject().realPath, async (cwd) =>
      reportSalesforceDeployment({
        sfClient: this.sfClient,
        deploymentId: job.salesforceDeploymentId!,
        targetAlias: job.targetAlias,
        cwd,
        phase: job.kind === 'DRY_RUN' ? 'DRY_RUN' : 'DEPLOY',
      }));
    const persistenceWarning = job.kind === 'DRY_RUN' && result.progress.done
      && result.progress.success !== false && !job.prepared
      ? '원격 dry-run은 성공했지만 고정 payload artifact가 없어 dry-run을 다시 실행해야 합니다.'
      : undefined;
    let reconciled = await this.jobs.recordReconciliationReport({
      id: job.id,
      actorUserId,
      report: result.report,
      progress: result.progress,
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
      job.kind === 'DRY_RUN' ? 'APPROVAL_PENDING' : 'SUCCEEDED',
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
    if (typeof snapshot.packageRoot !== 'string' || typeof snapshot.payloadSha256 !== 'string') {
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

function extractDeploymentIdFromText(value: string): string | undefined {
  return value.match(/\b0Af[A-Za-z0-9]{12,15}\b/u)?.[0];
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
