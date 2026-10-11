import type { UserSettingsRepository } from '../storage/user-settings-repository.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertGitMetadataScope } from '../sources/git-metadata-scope.js';

import { runCompareCommand } from '../commands/compare.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import { JobQueueCapacityError, JobQueueClosedError, type JobQueueReservation, SingleJobQueue } from '../deploy/single-job-queue.js';
import { ComparisonJobRepository, type ComparisonJob } from './comparison-job-repository.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import { immutableSourceSnapshot } from '../sources/source-provenance.js';
import { validateExcludedPackageIds } from '../metadata/package-exclusion.js';
import { normalizeSelectedComponents, writeSelectedManifest, type SelectedMetadataComponent } from '../deploy/selected-manifest.js';

export interface CreateComparisonInput {
  excludedPackageIds?: string[];
  excludePackageMetadata?: boolean;
  sessionWorkspaceId?: string;
  projectId?: string;
  scope?: 'manifest' | 'all' | 'selected';
  components?: SelectedMetadataComponent[];
  metadataType?: string;
  manifest?: string;
  leftSourceId: string;
  rightSourceId: string;
  sourceOnly?: boolean;
  strict: boolean;
  showIdentical: boolean;
  createdBy: string;
}

export class ComparisonService {
  public constructor(
    private readonly repository: ComparisonJobRepository,
    private readonly queue: SingleJobQueue,
    private readonly workspace: WorkspaceService,
    private readonly sfClient: SfClient,
    private readonly runsDirectory: string,
    private readonly settings?: UserSettingsRepository,
  ) {}

  public async create(input: CreateComparisonInput): Promise<ComparisonJob> {
    if (input.scope === 'selected') input = { ...input, components: normalizeSelectedComponents(input.components ?? []) };
    else if (input.components !== undefined) throw new Error('선택 항목은 selected 비교에서만 사용할 수 있습니다.');
    const jobId = randomUUID();
    const prepared: string[] = [];
    const releases: (() => void)[] = [];
    const prepare = async (id: string, side: string) => {
      if (!id.startsWith('git-registered:')) return id;
      const types = new Set(input.components?.map((component) => component.type));
      const metadataType = input.scope === 'selected' && types.size === 1 ? [...types][0] : input.metadataType;
      if (this.workspace.gitRegistrations === undefined || !['all', 'selected'].includes(input.scope ?? '') || metadataType === undefined) {
        throw new Error('등록 브랜치는 메타데이터 타입을 선택해 비교하세요.');
      }
      const record = await this.workspace.gitRegistrations.prepare(id.slice('git-registered:'.length), input.createdBy, metadataType,
        { sessionId: input.sessionWorkspaceId ?? randomUUID(), jobId, side });
      const sourceId = `git:${record.id}`;
      prepared.push(record.id);
      releases.push(this.workspace.pinSources([sourceId], input.createdBy));
      return sourceId;
    };
    this.queue.assertAccepting();
    if (input.sourceOnly !== true && input.leftSourceId === input.rightSourceId) throw new Error('서로 다른 비교 소스를 선택하세요.');
    let reservation: JobQueueReservation | undefined;
    try {
      reservation = this.queue.reserve();
      const rightSourceId = await prepare(input.rightSourceId, 'right');
      const leftSourceId = input.sourceOnly === true ? rightSourceId : await prepare(input.leftSourceId, 'left');
      return await this.createPrepared({ ...input, leftSourceId, rightSourceId }, jobId, reservation);
    } catch (error) {
      for (const release of releases) release();
      for (const id of prepared) await this.workspace.gitImports?.remove(id, input.createdBy).catch(() => undefined);
      if (error instanceof JobQueueCapacityError) {
        throw new SfudError('REQUEST_CAPACITY_EXCEEDED', '비교 대기 수가 서버 수용량에 도달했습니다. 잠시 후 다시 시도하세요.');
      }
      throw error;
    } finally {
      reservation?.release();
      for (const release of releases) release();
    }
  }

  private async createPrepared(input: CreateComparisonInput, jobId: string, reservation: JobQueueReservation): Promise<ComparisonJob> {
    this.queue.assertAccepting();
    const scope = input.scope ?? 'manifest';
    const rightResolved = await this.workspace.resolveSourceSnapshot(input.rightSourceId, input.createdBy);
    const leftResolved = input.sourceOnly === true
      ? rightResolved
      : await this.workspace.resolveSourceSnapshot(input.leftSourceId, input.createdBy);
    const rightSource = rightResolved.source;
    const leftSource = leftResolved.source;
    const excludedPackageIds = validateExcludedPackageIds(input.excludedPackageIds);
    if (input.excludePackageMetadata === true && excludedPackageIds.length > 0) {
      throw new Error('패키지 전체 제외와 개별 제외는 함께 선택할 수 없습니다.');
    }
    if ((input.excludePackageMetadata === true || excludedPackageIds.length > 0) && ![leftSource, rightSource].some((source) => source.startsWith('org:'))) {
      throw new Error('설치 패키지 제외에는 연결된 Salesforce Org가 하나 이상 필요합니다.');
    }
    for (const source of [leftSource, rightSource]) {
      assertGitMetadataScope(source === leftSource ? leftResolved.snapshot : rightResolved.snapshot,
        input.components?.map((component) => component.type) ?? (input.metadataType === undefined ? undefined : [input.metadataType]));
    }
    const project = scope !== 'manifest'
      ? this.workspace.projectForSources(input.sourceOnly === true ? [rightSource] : [leftSource, rightSource])
      : await this.workspace.resolveProject(requiredProjectId(input.projectId), input.createdBy);
    if (input.sourceOnly !== true && leftSource === rightSource) throw new Error('서로 다른 비교 소스를 선택하세요.');
    if (scope !== 'all' && input.metadataType !== undefined) {
      throw new Error('Salesforce metadata type은 전체 metadata 비교에서만 선택할 수 있습니다.');
    }
    if (scope === 'all' && input.metadataType === undefined) {
      throw new Error('전체 메타데이터 검색은 지원하지 않습니다. Salesforce metadata type을 선택하세요.');
    }
    if (input.metadataType !== undefined || input.components !== undefined) {
      const availableTypes = await this.workspace.listMetadataTypes([
        ...(input.sourceOnly === true ? [] : [input.leftSourceId]),
        input.rightSourceId,
      ], input.createdBy);
      if ((input.components?.map((component) => component.type) ?? [input.metadataType!]).some((type) => !availableTypes.some((entry) => entry.name === type))) {
        throw new Error(`선택한 Salesforce metadata type을 사용할 수 없습니다: ${input.metadataType}`);
      }
    }
    const manifestPath = scope === 'selected'
      ? (await writeSelectedManifest({ components: input.components!, projectPath: project.realPath, runsDirectory: this.runsDirectory, jobId })).manifestPath
      : scope === 'all'
      ? '@all'
      : (await this.workspace.resolveManifest(
        requiredProjectId(input.projectId),
        requiredManifest(input.manifest),
        input.createdBy,
      )).path;
    const releaseSources = this.workspace.pinSources(
      [...(input.sourceOnly === true ? [input.rightSourceId] : [input.leftSourceId, input.rightSourceId]),
        ...(scope === 'manifest' && input.projectId !== undefined ? [input.projectId] : [])],
      input.createdBy,
    );
    let job: ComparisonJob;
    try {
      this.queue.assertAccepting();
      job = await this.repository.create({
        excludedPackageIds,
        excludePackageMetadata: input.excludePackageMetadata === true,
        id: jobId,
        scope: scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        projectPath: project.realPath,
        manifestPath,
        leftSource,
        rightSource,
        sourceSnapshot: { left: immutableSourceSnapshot(leftResolved.snapshot), right: immutableSourceSnapshot(rightResolved.snapshot),
          project: this.workspace.publicSource(`local:${project.realPath}`),
          manifest: scope === 'selected' ? '선택 항목' : this.workspace.publicManifest(project.realPath, manifestPath) },
        strict: input.strict,
        showIdentical: input.showIdentical,
        createdBy: input.createdBy,
        accessOwnerUserId: input.createdBy,
      });
    } catch (error) {
      releaseSources();
      throw error;
    }
    void this.queue.enqueue(job.id, async (signal) => {
      try {
        await this.execute(job.id, signal, input.components?.map((component) => `${component.type}:${component.fullName}`));
      } finally {
        releaseSources();
      }
    }, reservation).catch(async (error: unknown) => {
      releaseSources();
      if (error instanceof JobQueueClosedError && (await this.repository.getRequired(job.id)).status === 'QUEUED') {
        await this.repository.markFailed(job.id, 'JOB_QUEUE_REJECTED',
          redactSensitiveText(error instanceof Error ? error.message : String(error)));
      }
    }).catch(() => undefined);
    return job;
  }

  private async execute(jobId: string, signal: AbortSignal, componentKeys?: string[]): Promise<void> {
    await this.repository.markRunning(jobId);
    const job = await this.repository.getRequired(jobId);
    try {
      const settings = await this.settings?.get(job.createdBy);
      const result = await runCompareCommand({
        excludedPackageIds: job.excludedPackageIds ?? [],
        excludePackageMetadata: job.excludePackageMetadata === true,
        maximumComparisonFiles: settings?.maximumComparisonFiles ?? 2000,
        ...(componentKeys === undefined ? {} : { componentKeys }),
        left: job.leftSource,
        right: job.rightSource,
        ...(job.scope === 'ALL'
          ? {
            allMetadata: true,
            ...(job.metadataType === undefined ? {} : { metadataType: job.metadataType }),
          }
          : { manifest: job.manifestPath }),
        reportDir: path.join(this.runsDirectory, job.id, ...(componentKeys === undefined ? [] : ['comparison'])),
        strict: job.strict,
        showIdentical: job.showIdentical,
        sourceOnly: job.leftSource === job.rightSource,
        color: false,
      }, {
        cwd: job.projectPath,
        sfClient: this.sfClient,
        stdout: () => undefined,
        signal,
        ...(job.sourceSnapshot === undefined ? {} : { sourceSnapshot: job.sourceSnapshot }),
      });
      await this.repository.markSucceeded(job.id, result.comparison, result.runDirectory);
    } catch (error) {
      const code = error instanceof SfudError ? error.code : 'COMPARISON_FAILED';
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      await this.repository.markFailed(job.id, code, message);
      throw error;
    }
  }
}

function requiredManifest(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error('manifest 선택이 필요합니다.');
  return value;
}

function requiredProjectId(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error('manifest 프로젝트 선택이 필요합니다.');
  return value;
}
