import { createHash } from 'node:crypto';
import path from 'node:path';

import { runDeployCommand } from '../commands/deploy.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import { DeploymentCoordinator, ReconciliationRequiredError } from './deployment-coordinator.js';
import { DeploymentJobRepository, type DeploymentJob } from './deployment-job-repository.js';
import type { RequestedTestLevel } from './test-plan.js';

const TEST_LEVELS: RequestedTestLevel[] = [
  'auto',
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
  'RunAllTestsInOrg',
  'RunRelevantTests',
];

export interface CreateDryRunInput {
  projectId?: string;
  scope?: 'manifest' | 'all';
  metadataType?: string;
  manifest?: string;
  sourceId: string;
  targetOrgId: string;
  testLevel: RequestedTestLevel;
  tests: string[];
  waitMinutes: number;
  strict: boolean;
  createdBy: string;
}

export class DryRunService {
  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly coordinator: DeploymentCoordinator,
    private readonly workspace: WorkspaceService,
    private readonly sfClient: SfClient,
    private readonly runsDirectory: string,
  ) {}

  public async create(input: CreateDryRunInput): Promise<DeploymentJob> {
    assertInput(input);
    if (input.scope !== undefined && input.scope !== 'manifest' && input.scope !== 'all') {
      throw new SfudError('INVALID_ARGUMENT', '지원하지 않는 배포 범위입니다.');
    }
    const scope = input.scope ?? 'manifest';
    const [project, source, targetSource] = await Promise.all([
      scope === 'all'
        ? Promise.resolve(this.workspace.defaultProject())
        : this.workspace.resolveProject(requiredString(input.projectId, '프로젝트')),
      this.workspace.resolveSource(input.sourceId),
      this.workspace.resolveSource(input.targetOrgId),
    ]);
    if (!targetSource.startsWith('org:')) throw new Error('dry-run 대상은 Salesforce org여야 합니다.');
    if (source === targetSource) throw new Error('배포 소스와 대상 org는 서로 달라야 합니다.');
    if (scope !== 'all' && input.metadataType !== undefined) {
      throw new Error('Salesforce metadata type은 전체 metadata 범위에서만 선택할 수 있습니다.');
    }
    if (input.metadataType !== undefined) {
      const availableTypes = await this.workspace.listMetadataTypes([input.sourceId, input.targetOrgId]);
      if (!availableTypes.some((entry) => entry.name === input.metadataType)) {
        throw new Error(`선택한 Salesforce metadata type을 사용할 수 없습니다: ${input.metadataType}`);
      }
    }
    const manifestPath = scope === 'all'
      ? '@all'
      : (await this.workspace.resolveManifest(
        requiredString(input.projectId, '프로젝트'),
        requiredString(input.manifest, 'manifest'),
      )).path;
    const targetAlias = targetSource.slice('org:'.length);
    const requestChecksum = createHash('sha256').update(JSON.stringify({
      projectPath: project.realPath,
      manifestPath,
      source,
      targetAlias,
      testLevel: input.testLevel,
      tests: [...input.tests].sort(),
      waitMinutes: input.waitMinutes,
      strict: input.strict,
      scope,
      metadataType: input.metadataType,
    })).digest('hex');
    const job = await this.jobs.createDryRun({
      source,
      targetAlias,
      manifestPath,
      payloadChecksum: requestChecksum,
      createdBy: input.createdBy,
      scope: scope === 'all' ? 'ALL' : 'MANIFEST',
      ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
    });

    void this.coordinator.runDryRun(job.id, async () => {
      try {
        const result = await runDeployCommand({
          from: source,
          to: targetAlias,
          ...(scope === 'all'
            ? {
              allMetadata: true,
              ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
            }
            : { manifest: manifestPath }),
          reportDir: path.join(this.runsDirectory, job.id),
          dryRun: true,
          testLevel: input.testLevel,
          tests: input.tests,
          wait: input.waitMinutes,
          strict: input.strict,
          color: false,
        }, {
          cwd: project.realPath,
          sfClient: this.sfClient,
          stdout: () => undefined,
        });
        const payloadChecksum = result.comparison.right.payloadSha256;
        await this.jobs.recordDryRunArtifacts({
          id: job.id,
          payloadChecksum,
          runDirectory: result.runDirectory,
          comparisonResult: result.comparison,
          testPlan: result.testPlan,
          dryRunResult: result.dryRunResult,
        });
        const deploymentId = extractDeploymentId(result.dryRunResult);
        return deploymentId === undefined ? {} : { deploymentId };
      } catch (error) {
        if (error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN') {
          const message = redactSensitiveText(error.message);
          throw new ReconciliationRequiredError(message, extractDeploymentIdFromText(message), { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }).catch(() => undefined);
    return job;
  }
}

function extractDeploymentIdFromText(value: string): string | undefined {
  return value.match(/\b0Af[A-Za-z0-9]{12,15}\b/u)?.[0];
}

function assertInput(input: CreateDryRunInput): void {
  if (!TEST_LEVELS.includes(input.testLevel)) {
    throw new SfudError('INVALID_ARGUMENT', '지원하지 않는 Apex 테스트 수준입니다.');
  }
  if (!Number.isInteger(input.waitMinutes) || input.waitMinutes < 1 || input.waitMinutes > 120) {
    throw new SfudError('INVALID_ARGUMENT', '대기 시간은 1분부터 120분 사이여야 합니다.');
  }
  if (input.tests.length > 200 || input.tests.some((test) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(test))) {
    throw new SfudError('INVALID_ARGUMENT', 'Apex 테스트 클래스 이름이 올바르지 않습니다.');
  }
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new SfudError('INVALID_ARGUMENT', `${label} 선택이 필요합니다.`);
  return value;
}

function extractDeploymentId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const result = 'result' in value && typeof value.result === 'object' && value.result !== null
    ? value.result as Record<string, unknown>
    : value as Record<string, unknown>;
  for (const key of ['id', 'deployId', 'deploymentId']) {
    if (typeof result[key] === 'string' && result[key].length > 0) return result[key];
  }
  return undefined;
}
