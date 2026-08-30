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
import { runAsyncSalesforceDeployment } from './salesforce-deployment.js';

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
    const job = await this.jobs.approveAndQueueDeployment(input);
    void this.coordinator.runDeployment(job.id, async () => {
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
            onProgress: async (progress) => { await this.jobs.recordSalesforceProgress(current.id, progress); },
          })));
        await this.jobs.recordDeploymentResult(current.id, result);
        const deploymentId = extractDeploymentId(result);
        return deploymentId === undefined ? {} : { deploymentId };
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
