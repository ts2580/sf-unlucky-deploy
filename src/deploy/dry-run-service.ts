import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertGitMetadataScope } from '../sources/git-metadata-scope.js';
import { immutableSourceSnapshot } from '../sources/source-provenance.js';

import type { UserSettingsRepository } from '../storage/user-settings-repository.js';
import type { OrgExecutionAccessRepository } from '../storage/org-execution-access-repository.js';
import { runDeployCommand } from '../commands/deploy.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import type { WorkspaceSource } from '../api/workspace-contracts.js';
import type { AllowedProject, WorkspaceService } from '../web/server/workspace-service.js';
import { DeploymentCoordinator, ReconciliationRequiredError } from './deployment-coordinator.js';
import { DeploymentJobRepository, type DeploymentJob } from './deployment-job-repository.js';
import { assertDeploymentOrgIdentities } from './org-identity-verifier.js';
import type { OrgIdentitySnapshot } from './org-identity.js';
import {
  normalizeSelectedComponents,
  type SelectedMetadataComponent,
  writeSelectedManifest,
} from './selected-manifest.js';
import type { RequestedTestLevel } from './test-plan.js';
import { ExternalDeploymentStateUnknownError } from './salesforce-deployment.js';
import { DeploymentAdmissionLimiter } from './deployment-admission-limiter.js';
import type { DeploymentAdmissionRepository } from './deployment-admission-repository.js';
import type { JobQueueReservation } from './single-job-queue.js';

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
  clientRequestId: string;
}

export interface CreateDirectDeploymentInput extends CreateDryRunInput {
  clientRequestId: string;
  targetConfirmation: string;
  confirmation: string;
}

export interface CreateDirectDeploymentResult {
  job: DeploymentJob;
  created: boolean;
}

interface PreparedDeploymentRequest {
  source: string;
  sourceSnapshot: WorkspaceSource;
  targetAlias: string;
  project: AllowedProject;
  scope: 'manifest' | 'all' | 'selected';
  manifestPath: string;
  selectedComponents?: SelectedMetadataComponent[];
  requestChecksum: string;
  sourceOrgIdentity?: OrgIdentitySnapshot;
  targetOrgIdentity: OrgIdentitySnapshot;
  releaseSources: () => void;
}

export class DryRunService {
  private readonly admission = new DeploymentAdmissionLimiter();
  private readonly inFlightRequests = new Map<string, { requestHash: string; promise: Promise<unknown> }>();

  public constructor(
    private readonly jobs: DeploymentJobRepository,
    private readonly coordinator: DeploymentCoordinator,
    private readonly workspace: WorkspaceService,
    private readonly sfClient: SfClient,
    private readonly runsDirectory: string,
    private readonly settings?: UserSettingsRepository,
    private readonly durableAdmission?: DeploymentAdmissionRepository,
    private readonly orgExecutionAccess?: OrgExecutionAccessRepository,
    private readonly assertRunStorageCapacity?: () => Promise<void>,
  ) {}

  public async create(input: CreateDryRunInput): Promise<DeploymentJob> {
    assertInput(input);
    const requestHash = requestIdentityHash(input);
    const request = this.coalesceRequest('DRY_RUN', input.createdBy, input.clientRequestId, requestHash, async () => {
      const existing = await this.jobs.findIdempotentDryRun(input.createdBy, input.clientRequestId);
      if (existing !== undefined) return this.returnExisting(existing, requestHash);
      return await this.createReserved(input, requestHash);
    });
    return await request.promise;
  }

  private async createReserved(input: CreateDryRunInput, requestHash: string): Promise<DeploymentJob> {
    this.coordinator.assertAccepting();
    const releaseAdmission = await this.reserveAdmission(input.createdBy);
    let queueReservation: JobQueueReservation | undefined;
    let prepared: PreparedDeploymentRequest | undefined;
    let creation: { job: DeploymentJob; created: boolean };
    try {
      queueReservation = this.coordinator.reserveQueueSlot();
      const existing = await this.jobs.findIdempotentDryRun(input.createdBy, input.clientRequestId);
      if (existing !== undefined) {
        queueReservation.release();
        await releaseAdmission();
        return this.returnExisting(existing, requestHash);
      }
      await this.assertRunStorageCapacity?.();
      prepared = await this.prepare(input);
      this.coordinator.assertAccepting();
      creation = await this.jobs.createIdempotentDryRun({
        source: prepared.source,
        sourceSnapshot: { source: immutableSourceSnapshot(prepared.sourceSnapshot),
          project: this.workspace.publicSource(`local:${prepared.project.realPath}`),
          manifest: prepared.scope === 'selected'
            ? '선택 항목'
            : this.workspace.publicManifest(prepared.project.realPath, prepared.manifestPath) },
        targetAlias: prepared.targetAlias,
        manifestPath: prepared.manifestPath,
        payloadChecksum: prepared.requestChecksum,
        targetOrgIdentity: prepared.targetOrgIdentity,
        ...(prepared.sourceOrgIdentity === undefined ? {} : { sourceOrgIdentity: prepared.sourceOrgIdentity }),
        createdBy: input.createdBy,
        ...([input.sourceId, input.projectId].some((id) => /^(git|upload):/u.test(id ?? ''))
          ? { accessOwnerUserId: input.createdBy } : {}),
        clientRequestId: input.clientRequestId,
        requestHash,
        scope: prepared.scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        ...(prepared.selectedComponents === undefined ? {} : { selectedComponents: prepared.selectedComponents }),
      });
    } catch (error) {
      prepared?.releaseSources();
      queueReservation?.release();
      await releaseAdmission();
      throw error;
    }

    let job = creation.job;
    if (!creation.created) {
      prepared.releaseSources();
      queueReservation!.release();
      await releaseAdmission();
      return job;
    }
    try {
      job = await this.materializeSelectedManifest(job, prepared);
    } catch (error) {
      prepared.releaseSources();
      queueReservation!.release();
      await releaseAdmission();
      throw error;
    }
    await releaseAdmission();

    void this.coordinator.runDryRun(job.id, async (signal) => {
      const persistenceWarnings: string[] = [];
      const attempts = new Map<string, string>();
      try {
        await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
        const settings = await this.settings?.get(input.createdBy);
        const result = await runDeployCommand({
          maximumComparisonFiles: settings?.maximumComparisonFiles ?? 2000,
          from: prepared.source,
          to: prepared.targetAlias,
          ...(prepared.scope === 'all'
            ? {
              allMetadata: true,
              ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
            }
            : { manifest: prepared.manifestPath }),
          reportDir: path.join(this.runsDirectory, job.id, 'output'),
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
          signal,
          ...(job.sourceSnapshot === undefined ? {} : { sourceSnapshot: job.sourceSnapshot }),
          beforeDeploymentSubmit: async (phase, payload) => {
            await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
            attempts.set(phase, await this.jobs.attempts.begin({
              jobId: job.id, operation: phase === 'DRY_RUN' ? 'VALIDATE' : 'DEPLOY',
              ...payload, digestVersion: 2,
            }));
          },
          onDeploymentSubmitted: async (deploymentId, phase) => {
            await this.jobs.recordSalesforceSubmission(job.id, deploymentId, attempts.get(phase));
          },
          onDeploymentProgress: async (progress) => {
            await this.jobs.recordSalesforceProgress(job.id, progress, attempts.get(progress.phase));
          },
          onDeploymentPersistenceError: (stage, error) => {
            persistenceWarnings.push(persistenceWarning(stage, error));
          },
        });
        persistenceWarnings.push(...(result.persistenceWarnings ?? []).map((warning) => redactSensitiveText(warning)));
        const payloadChecksum = result.payloadSha256;
        const deploymentId = extractDeploymentId(result.dryRunResult);
        const attempt = await this.jobs.attempts.current(job.id);
        try {
          await this.jobs.recordDryRunArtifacts({
            id: job.id,
            payloadChecksum,
            runDirectory: result.runDirectory,
            comparisonResult: result.comparison,
            testPlan: result.testPlan,
            dryRunResult: result.dryRunResult,
          });
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
        if (error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN') {
          const message = redactSensitiveText(error.message);
          throw new ReconciliationRequiredError(message, error instanceof ExternalDeploymentStateUnknownError ? error.deploymentId : undefined, { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }, queueReservation!).finally(prepared.releaseSources).catch(() => undefined);
    return job;
  }

  public async createDirect(input: CreateDirectDeploymentInput): Promise<CreateDirectDeploymentResult> {
    const tests = [...new Set(input.tests)].sort((left, right) => left.localeCompare(right));
    const request: CreateDryRunInput = { ...input, tests };
    assertInput(request);
    const requestHash = requestIdentityHash(input);
    const requestState = this.coalesceRequest('DIRECT', input.createdBy, input.clientRequestId, requestHash, async () => {
      const existing = await this.jobs.findIdempotentDirectDeployment(input.createdBy, input.clientRequestId);
      if (existing !== undefined) return { job: this.returnExisting(existing, requestHash), created: false };
      return await this.createDirectReserved(input, request, requestHash);
    });
    const result = await requestState.promise;
    return requestState.joined ? { ...result, created: false } : result;
  }

  private async createDirectReserved(
    input: CreateDirectDeploymentInput,
    request: CreateDryRunInput,
    requestHash: string,
  ): Promise<CreateDirectDeploymentResult> {
    this.coordinator.assertAccepting();
    const tests = request.tests;
    const releaseAdmission = await this.reserveAdmission(input.createdBy);
    let queueReservation: JobQueueReservation | undefined;
    let prepared: PreparedDeploymentRequest | undefined;
    let creation: CreateDirectDeploymentResult;
    try {
      queueReservation = this.coordinator.reserveQueueSlot();
      const existing = await this.jobs.findIdempotentDirectDeployment(input.createdBy, input.clientRequestId);
      if (existing !== undefined) {
        queueReservation.release();
        await releaseAdmission();
        return { job: this.returnExisting(existing, requestHash), created: false };
      }
      await this.assertRunStorageCapacity?.();
      prepared = await this.prepare(request);
      this.coordinator.assertAccepting();
      creation = await this.jobs.createDirectDeployment({
        source: prepared.source,
        sourceSnapshot: { source: immutableSourceSnapshot(prepared.sourceSnapshot),
          project: this.workspace.publicSource(`local:${prepared.project.realPath}`),
          manifest: prepared.scope === 'selected'
            ? '선택 항목'
            : this.workspace.publicManifest(prepared.project.realPath, prepared.manifestPath) },
        targetAlias: prepared.targetAlias,
        targetConfirmation: input.targetConfirmation,
        confirmation: input.confirmation,
        manifestPath: prepared.manifestPath,
        payloadChecksum: prepared.requestChecksum,
        requestHash,
        clientRequestId: input.clientRequestId,
        targetOrgIdentity: prepared.targetOrgIdentity,
        ...(prepared.sourceOrgIdentity === undefined ? {} : { sourceOrgIdentity: prepared.sourceOrgIdentity }),
        createdBy: input.createdBy,
        ...([input.sourceId, input.projectId].some((id) => /^(git|upload):/u.test(id ?? ''))
          ? { accessOwnerUserId: input.createdBy } : {}),
        scope: prepared.scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        ...(prepared.selectedComponents === undefined ? {} : { selectedComponents: prepared.selectedComponents }),
        requestedTestLevel: input.testLevel,
        requestedTests: tests,
      });
    } catch (error) {
      prepared?.releaseSources();
      queueReservation?.release();
      await releaseAdmission();
      throw error;
    }
    let job = creation.job;
    if (!creation.created) {
      prepared.releaseSources();
      queueReservation!.release();
      await releaseAdmission();
      return creation;
    }
    try {
      job = await this.materializeSelectedManifest(job, prepared);
    } catch (error) {
      prepared.releaseSources();
      queueReservation!.release();
      await releaseAdmission();
      throw error;
    }
    await releaseAdmission();

    void this.coordinator.runDeployment(job.id, async (signal) => {
      const persistenceWarnings: string[] = [];
      const attempts = new Map<string, string>();
      try {
        await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
        const settings = await this.settings?.get(input.createdBy);
        const result = await runDeployCommand({
          maximumComparisonFiles: settings?.maximumComparisonFiles ?? 2000,
          from: prepared.source,
          to: prepared.targetAlias,
          ...(prepared.scope === 'all'
            ? {
              allMetadata: true,
              ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
            }
            : { manifest: prepared.manifestPath }),
          reportDir: path.join(this.runsDirectory, job.id, 'output'),
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
          signal,
          ...(job.sourceSnapshot === undefined ? {} : { sourceSnapshot: job.sourceSnapshot }),
          beforeDeploymentSubmit: async (phase, payload) => {
            if (phase === 'DEPLOY') {
              await this.jobs.assertAccess(job.id, input.createdBy);
              await this.orgExecutionAccess?.assertCanExecute(job.targetAlias, input.createdBy);
            }
            await assertDeploymentOrgIdentities(job, this.jobs, this.workspace);
            attempts.set(phase, await this.jobs.attempts.begin({
              jobId: job.id, operation: phase === 'DRY_RUN' ? 'VALIDATE' : 'DEPLOY',
              ...payload, digestVersion: 2,
            }));
          },
          onDeploymentSubmitted: async (deploymentId, phase) => {
            await this.jobs.recordSalesforceSubmission(job.id, deploymentId, attempts.get(phase));
          },
          onDeploymentProgress: async (progress) => {
            await this.jobs.recordSalesforceProgress(job.id, progress, attempts.get(progress.phase));
          },
          onDeploymentPersistenceError: (stage, error) => {
            persistenceWarnings.push(persistenceWarning(stage, error));
          },
        });
        persistenceWarnings.push(...(result.persistenceWarnings ?? []).map((warning) => redactSensitiveText(warning)));
        if (result.deployResult === undefined) {
          throw new SfudError('DEPLOY_FAILED', 'Salesforce 실제 배포 결과가 없습니다.');
        }
        const deploymentId = extractDeploymentId(result.deployResult);
        const attempt = await this.jobs.attempts.current(job.id);
        try {
          await this.jobs.recordDirectDeploymentArtifacts({
            id: job.id,
            payloadChecksum: result.payloadSha256,
            runDirectory: result.runDirectory,
            comparisonResult: result.comparison,
            testPlan: result.testPlan,
            ...(result.dryRunResult === undefined ? {} : { dryRunResult: result.dryRunResult }),
            deploymentResult: result.deployResult,
          });
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
        if (error instanceof SfudError && error.code === 'SF_EXTERNAL_STATE_UNKNOWN') {
          const message = redactSensitiveText(error.message);
          throw new ReconciliationRequiredError(message, error instanceof ExternalDeploymentStateUnknownError ? error.deploymentId : undefined, { cause: error });
        }
        if (error instanceof Error) error.message = redactSensitiveText(error.message);
        throw error;
      }
    }, queueReservation!).finally(prepared.releaseSources).catch(() => undefined);
    return { job, created: true };
  }

  private async prepare(input: CreateDryRunInput): Promise<PreparedDeploymentRequest> {
    assertInput(input);
    if (!input.targetOrgId.startsWith('org:')) {
      throw new SfudError('INVALID_ARGUMENT', 'Git 저장소는 비교 전용입니다. Dry-run과 배포 대상은 Salesforce org여야 합니다.');
    }
    if (input.scope !== undefined && !['manifest', 'all', 'selected'].includes(input.scope)) {
      throw new SfudError('INVALID_ARGUMENT', '지원하지 않는 배포 범위입니다.');
    }
    const scope = input.scope ?? 'manifest';
    const [resolvedSource, targetSource] = await Promise.all([
      this.workspace.resolveSourceSnapshot(input.sourceId, input.createdBy),
      this.workspace.resolveSource(input.targetOrgId, input.createdBy),
    ]);
    const source = resolvedSource.source;
    const project = scope === 'all' || scope === 'selected'
      ? this.workspace.projectForSources([source, targetSource])
      : await this.workspace.resolveProject(requiredString(input.projectId, '프로젝트'), input.createdBy);
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
    assertGitMetadataScope(resolvedSource.snapshot, selectedComponents?.map((component) => component.type)
      ?? (input.metadataType === undefined ? undefined : [input.metadataType]));
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
    const manifestPath = scope === 'all'
      ? '@all'
      : selectedComponents === undefined ? (await this.workspace.resolveManifest(
        requiredString(input.projectId, '프로젝트'),
        requiredString(input.manifest, 'manifest'),
        input.createdBy,
      )).path : '@selected';
    const targetAlias = targetSource.slice('org:'.length);
    const [sourceOrgIdentity, targetOrgIdentity] = await Promise.all([
      source.startsWith('org:')
        ? this.workspace.getOrgIdentity(source.slice('org:'.length))
        : Promise.resolve(undefined),
      this.workspace.getOrgIdentity(targetAlias),
    ]);
    const requestChecksum = createHash('sha256').update(JSON.stringify({
      projectPath: project.realPath,
      ...(scope === 'selected' ? {} : { manifestPath }),
      source,
      sourceSnapshot: immutableSourceSnapshot(resolvedSource.snapshot),
      targetAlias,
      testLevel: input.testLevel,
      tests: [...input.tests].sort(),
      testClassSuffix: input.testClassSuffix,
      waitMinutes: input.waitMinutes,
      strict: input.strict,
      scope,
      metadataType: input.metadataType,
      selectedComponents,
      sourceOrgIdentity,
      targetOrgIdentity,
    })).digest('hex');
    return {
      source,
      sourceSnapshot: immutableSourceSnapshot(resolvedSource.snapshot),
      targetAlias,
      project,
      scope,
      manifestPath,
      ...(selectedComponents === undefined ? {} : { selectedComponents }),
      requestChecksum,
      ...(sourceOrgIdentity === undefined ? {} : { sourceOrgIdentity }),
      targetOrgIdentity,
      releaseSources: this.workspace.pinSources([input.sourceId,
        ...(scope === 'manifest' && input.projectId !== undefined ? [input.projectId] : [])], input.createdBy),
    };
  }

  private async materializeSelectedManifest(
    job: DeploymentJob,
    prepared: PreparedDeploymentRequest,
  ): Promise<DeploymentJob> {
    if (prepared.selectedComponents === undefined) return job;
    try {
      const selected = await writeSelectedManifest({
        components: prepared.selectedComponents,
        projectPath: prepared.project.realPath,
        runsDirectory: this.runsDirectory,
        jobId: job.id,
      });
      prepared.manifestPath = selected.manifestPath;
      return await this.jobs.recordSelectedManifest(job.id, selected.manifestPath);
    } catch (error) {
      const message = error instanceof Error ? redactSensitiveText(error.message) : '선택 manifest 준비에 실패했습니다.';
      await this.jobs.transition(job.id, 'FAILED', {
        errorCode: 'MANIFEST_PREPARATION_FAILED', errorMessage: message,
      }).catch(() => undefined);
      throw error;
    }
  }

  private returnExisting(
    existing: { job: DeploymentJob; requestHash: string },
    requestHash: string,
  ): DeploymentJob {
    if (existing.requestHash !== requestHash) {
      throw new SfudError('IDEMPOTENCY_CONFLICT', '같은 Idempotency-Key가 다른 배포 요청에 사용되었습니다.');
    }
    return existing.job;
  }

  private async reserveAdmission(userId: string): Promise<() => Promise<void>> {
    const local = this.admission.reserve(userId);
    try {
      const durable = await this.durableAdmission?.reserve(userId);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        local.release();
        await durable?.release();
      };
    } catch (error) {
      local.release();
      throw error;
    }
  }

  private coalesceRequest<T>(
    kind: 'DRY_RUN' | 'DIRECT',
    userId: string,
    clientRequestId: string,
    requestHash: string,
    create: () => Promise<T>,
  ): { promise: Promise<T>; joined: boolean } {
    const key = `${kind}\u0000${userId}\u0000${clientRequestId}`;
    const existing = this.inFlightRequests.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new SfudError('IDEMPOTENCY_CONFLICT', '같은 Idempotency-Key가 다른 배포 요청에 사용되었습니다.');
      }
      return { promise: existing.promise as Promise<T>, joined: true };
    }
    const promise = create().finally(() => {
      if (this.inFlightRequests.get(key)?.promise === promise) this.inFlightRequests.delete(key);
    });
    this.inFlightRequests.set(key, { requestHash, promise });
    return { promise, joined: false };
  }
}

function persistenceWarning(stage: 'submission' | 'progress' | 'artifacts', error: unknown): string {
  const label = stage === 'submission'
    ? 'Salesforce 배포 ID'
    : stage === 'progress' ? 'Salesforce 진행 상태' : '배포 상세 결과';
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return `${label} 저장 실패: ${message}`;
}

function requestIdentityHash(input: CreateDryRunInput | CreateDirectDeploymentInput): string {
  const scope = input.scope ?? 'manifest';
  const components = input.components === undefined
    ? undefined
    : normalizeSelectedComponents(input.components);
  return createHash('sha256').update(JSON.stringify({
    projectId: input.projectId,
    scope,
    metadataType: input.metadataType,
    manifest: input.manifest,
    components,
    sourceId: input.sourceId,
    targetOrgId: input.targetOrgId,
    testLevel: input.testLevel,
    tests: [...input.tests].sort(),
    testClassSuffix: input.testClassSuffix,
    waitMinutes: input.waitMinutes,
    strict: input.strict,
    ...('targetConfirmation' in input
      ? { targetConfirmation: input.targetConfirmation, confirmation: input.confirmation }
      : {}),
  })).digest('hex');
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
