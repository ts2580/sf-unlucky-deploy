import { createHash } from 'node:crypto';
import path from 'node:path';

import { runDeployCommand } from '../commands/deploy.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import type { AllowedProject, WorkspaceService } from '../web/server/workspace-service.js';
import { DeploymentCoordinator, ReconciliationRequiredError } from './deployment-coordinator.js';
import { DeploymentJobRepository, type DeploymentJob } from './deployment-job-repository.js';
import {
  normalizeSelectedComponents,
  type SelectedMetadataComponent,
  writeSelectedManifest,
} from './selected-manifest.js';
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
  scope?: 'manifest' | 'all' | 'selected';
  metadataType?: string;
  manifest?: string;
  components?: SelectedMetadataComponent[];
  sourceId: string;
  targetOrgId: string;
  testLevel: RequestedTestLevel;
  tests: string[];
  testClassSuffix: string;
  waitMinutes: number;
  strict: boolean;
  createdBy: string;
}

export interface CreateDirectDeploymentInput extends CreateDryRunInput {
  targetConfirmation: string;
  confirmation: string;
}

interface PreparedDeploymentRequest {
  source: string;
  targetAlias: string;
  project: AllowedProject;
  scope: 'manifest' | 'all' | 'selected';
  manifestPath: string;
  selectedComponents?: SelectedMetadataComponent[];
  requestChecksum: string;
  releaseSources: () => void;
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
    const prepared = await this.prepare(input);
    let job: DeploymentJob;
    try {
      job = await this.jobs.createDryRun({
        source: prepared.source,
        targetAlias: prepared.targetAlias,
        manifestPath: prepared.manifestPath,
        payloadChecksum: prepared.requestChecksum,
        createdBy: input.createdBy,
        scope: prepared.scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        ...(prepared.selectedComponents === undefined ? {} : { selectedComponents: prepared.selectedComponents }),
      });
    } catch (error) {
      prepared.releaseSources();
      throw error;
    }

    void this.coordinator.runDryRun(job.id, async () => {
      try {
        const result = await runDeployCommand({
          from: prepared.source,
          to: prepared.targetAlias,
          ...(prepared.scope === 'all'
            ? {
              allMetadata: true,
              ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
            }
            : { manifest: prepared.manifestPath }),
          reportDir: path.join(this.runsDirectory, job.id),
          dryRun: true,
          testLevel: input.testLevel,
          tests: input.tests,
          testClassSuffix: input.testClassSuffix,
          ...(input.tests.length === 0 ? {} : { minimumCoverage: 75 }),
          wait: input.waitMinutes,
          strict: input.strict,
          color: false,
        }, {
          cwd: prepared.project.realPath,
          sfClient: this.sfClient,
          stdout: () => undefined,
          onDeploymentProgress: async (progress) => { await this.jobs.recordSalesforceProgress(job.id, progress); },
        });
        const payloadChecksum = result.payloadSha256;
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
    }).finally(prepared.releaseSources).catch(() => undefined);
    return job;
  }

  public async createDirect(input: CreateDirectDeploymentInput): Promise<DeploymentJob> {
    const tests = [...new Set(input.tests)].sort((left, right) => left.localeCompare(right));
    const request: CreateDryRunInput = { ...input, tests };
    const prepared = await this.prepare(request);
    let job: DeploymentJob;
    try {
      job = await this.jobs.createDirectDeployment({
        source: prepared.source,
        targetAlias: prepared.targetAlias,
        targetConfirmation: input.targetConfirmation,
        confirmation: input.confirmation,
        manifestPath: prepared.manifestPath,
        payloadChecksum: prepared.requestChecksum,
        createdBy: input.createdBy,
        scope: prepared.scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        ...(prepared.selectedComponents === undefined ? {} : { selectedComponents: prepared.selectedComponents }),
        requestedTestLevel: input.testLevel,
        requestedTests: tests,
      });
    } catch (error) {
      prepared.releaseSources();
      throw error;
    }

    void this.coordinator.runDeployment(job.id, async () => {
      try {
        const result = await runDeployCommand({
          from: prepared.source,
          to: prepared.targetAlias,
          ...(prepared.scope === 'all'
            ? {
              allMetadata: true,
              ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
            }
            : { manifest: prepared.manifestPath }),
          reportDir: path.join(this.runsDirectory, job.id),
          execute: true,
          skipDryRun: input.testLevel === 'NoTestRun',
          ...(tests.length === 0 ? {} : { minimumCoverage: 75 }),
          testLevel: input.testLevel,
          tests,
          testClassSuffix: input.testClassSuffix,
          wait: input.waitMinutes,
          strict: input.strict,
          color: false,
        }, {
          cwd: prepared.project.realPath,
          sfClient: this.sfClient,
          stdout: () => undefined,
          onDeploymentProgress: async (progress) => { await this.jobs.recordSalesforceProgress(job.id, progress); },
        });
        if (result.deployResult === undefined) {
          throw new SfudError('DEPLOY_FAILED', 'Salesforce 실제 배포 결과가 없습니다.');
        }
        await this.jobs.recordDirectDeploymentArtifacts({
          id: job.id,
          payloadChecksum: result.payloadSha256,
          runDirectory: result.runDirectory,
          comparisonResult: result.comparison,
          testPlan: result.testPlan,
          ...(result.dryRunResult === undefined ? {} : { dryRunResult: result.dryRunResult }),
          deploymentResult: result.deployResult,
        });
        const deploymentId = extractDeploymentId(result.deployResult);
        return deploymentId === undefined ? {} : { deploymentId };
      } catch (error) {
        if (error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN') {
          const message = redactSensitiveText(error.message);
          throw new ReconciliationRequiredError(message, extractDeploymentIdFromText(message), { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }).finally(prepared.releaseSources).catch(() => undefined);
    return job;
  }

  private async prepare(input: CreateDryRunInput): Promise<PreparedDeploymentRequest> {
    assertInput(input);
    if (input.scope !== undefined && !['manifest', 'all', 'selected'].includes(input.scope)) {
      throw new SfudError('INVALID_ARGUMENT', '지원하지 않는 배포 범위입니다.');
    }
    const scope = input.scope ?? 'manifest';
    const [source, targetSource] = await Promise.all([
      this.workspace.resolveSource(input.sourceId, input.createdBy),
      this.workspace.resolveSource(input.targetOrgId, input.createdBy),
    ]);
    const project = scope === 'all' || scope === 'selected'
      ? this.workspace.projectForSources([source, targetSource])
      : await this.workspace.resolveProject(requiredString(input.projectId, '프로젝트'));
    if (!targetSource.startsWith('org:')) throw new Error('배포 대상은 Salesforce org여야 합니다.');
    if (source === targetSource) throw new Error('배포 소스와 대상 org는 서로 달라야 합니다.');
    if (scope !== 'all' && input.metadataType !== undefined) {
      throw new Error('Salesforce metadata type은 전체 metadata 범위에서만 선택할 수 있습니다.');
    }
    if (scope !== 'selected' && input.components !== undefined) {
      throw new Error('배포 대상 항목은 선택한 metadata 범위에서만 사용할 수 있습니다.');
    }
    const selectedComponents = scope === 'selected'
      ? normalizeSelectedComponents(input.components ?? [])
      : undefined;
    if (input.metadataType !== undefined || selectedComponents !== undefined) {
      const availableTypes = await this.workspace.listMetadataTypes(
        [input.sourceId, input.targetOrgId],
        input.createdBy,
      );
      const availableTypeNames = new Set(availableTypes.map((entry) => entry.name));
      if (input.metadataType !== undefined && !availableTypeNames.has(input.metadataType)) {
        throw new Error(`선택한 Salesforce metadata type을 사용할 수 없습니다: ${input.metadataType}`);
      }
      const unavailable = selectedComponents?.find((component) => !availableTypeNames.has(component.type));
      if (unavailable !== undefined) {
        throw new Error(`선택한 Salesforce metadata type을 사용할 수 없습니다: ${unavailable.type}`);
      }
    }
    const selectedManifest = selectedComponents === undefined
      ? undefined
      : await writeSelectedManifest({
        components: selectedComponents,
        projectPath: project.realPath,
        runsDirectory: this.runsDirectory,
      });
    const manifestPath = scope === 'all'
      ? '@all'
      : selectedManifest?.manifestPath ?? (await this.workspace.resolveManifest(
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
      testClassSuffix: input.testClassSuffix,
      waitMinutes: input.waitMinutes,
      strict: input.strict,
      scope,
      metadataType: input.metadataType,
      selectedComponents,
    })).digest('hex');
    return {
      source,
      targetAlias,
      project,
      scope,
      manifestPath,
      ...(selectedComponents === undefined ? {} : { selectedComponents }),
      requestChecksum,
      releaseSources: this.workspace.pinSources([input.sourceId], input.createdBy),
    };
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
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(input.testClassSuffix)) {
    throw new SfudError('INVALID_ARGUMENT', 'Apex 테스트 클래스 접미사가 올바르지 않습니다.');
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
