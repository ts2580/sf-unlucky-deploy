import type { UserSettingsRepository } from '../storage/user-settings-repository.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertGitMetadataScope } from '../sources/git-metadata-scope.js';

import { runCompareCommand } from '../commands/compare.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import { SingleJobQueue } from '../deploy/single-job-queue.js';
import { ComparisonJobRepository, type ComparisonJob } from './comparison-job-repository.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import { immutableSourceSnapshot } from '../sources/source-provenance.js';

export interface CreateComparisonInput {
  sessionWorkspaceId?: string;
  projectId?: string;
  scope?: 'manifest' | 'all';
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
    const jobId = randomUUID();
    const prepared: string[] = [];
    const releases: (() => void)[] = [];
    const prepare = async (id: string, side: string) => {
      if (!id.startsWith('git-registered:')) return id;
      if (this.workspace.gitRegistrations === undefined || input.scope !== 'all' || input.metadataType === undefined) {
        throw new Error('등록 브랜치는 메타데이터 타입을 선택해 비교하세요.');
      }
      const record = await this.workspace.gitRegistrations.prepare(id.slice('git-registered:'.length), input.createdBy, input.metadataType,
        { sessionId: input.sessionWorkspaceId ?? randomUUID(), jobId, side });
      const sourceId = `git:${record.id}`;
      prepared.push(record.id);
      releases.push(this.workspace.pinSources([sourceId], input.createdBy));
      return sourceId;
    };
    this.queue.assertAccepting();
    if (input.sourceOnly !== true && input.leftSourceId === input.rightSourceId) throw new Error('서로 다른 비교 소스를 선택하세요.');
    try {
      const rightSourceId = await prepare(input.rightSourceId, 'right');
      const leftSourceId = input.sourceOnly === true ? rightSourceId : await prepare(input.leftSourceId, 'left');
      return await this.createPrepared({ ...input, leftSourceId, rightSourceId }, jobId);
    } catch (error) {
      for (const release of releases) release();
      for (const id of prepared) await this.workspace.gitImports?.remove(id, input.createdBy).catch(() => undefined);
      throw error;
    } finally { for (const release of releases) release(); }
  }

  private async createPrepared(input: CreateComparisonInput, jobId: string): Promise<ComparisonJob> {
    this.queue.assertAccepting();
    const scope = input.scope ?? 'manifest';
    const rightResolved = await this.workspace.resolveSourceSnapshot(input.rightSourceId, input.createdBy);
    const leftResolved = input.sourceOnly === true
      ? rightResolved
      : await this.workspace.resolveSourceSnapshot(input.leftSourceId, input.createdBy);
    const rightSource = rightResolved.source;
    const leftSource = leftResolved.source;
    for (const source of [leftSource, rightSource]) {
      assertGitMetadataScope(source === leftSource ? leftResolved.snapshot : rightResolved.snapshot,
        input.metadataType === undefined ? undefined : [input.metadataType]);
    }
    const project = scope === 'all'
      ? this.workspace.projectForSources(input.sourceOnly === true ? [rightSource] : [leftSource, rightSource])
      : await this.workspace.resolveProject(requiredProjectId(input.projectId), input.createdBy);
    if (input.sourceOnly !== true && leftSource === rightSource) throw new Error('서로 다른 비교 소스를 선택하세요.');
    if (scope !== 'all' && input.metadataType !== undefined) {
      throw new Error('Salesforce metadata type은 전체 metadata 비교에서만 선택할 수 있습니다.');
    }
    if (scope === 'all' && input.metadataType === undefined) {
      throw new Error('전체 메타데이터 검색은 지원하지 않습니다. Salesforce metadata type을 선택하세요.');
    }
    if (input.metadataType !== undefined) {
      const availableTypes = await this.workspace.listMetadataTypes([
        ...(input.sourceOnly === true ? [] : [input.leftSourceId]),
        input.rightSourceId,
      ], input.createdBy);
      if (!availableTypes.some((entry) => entry.name === input.metadataType)) {
        throw new Error(`선택한 Salesforce metadata type을 사용할 수 없습니다: ${input.metadataType}`);
      }
    }
    const manifestPath = scope === 'all'
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
        id: jobId,
        scope: scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        projectPath: project.realPath,
        manifestPath,
        leftSource,
        rightSource,
        sourceSnapshot: { left: immutableSourceSnapshot(leftResolved.snapshot), right: immutableSourceSnapshot(rightResolved.snapshot),
          project: this.workspace.publicSource(`local:${project.realPath}`),
          manifest: this.workspace.publicManifest(project.realPath, manifestPath) },
        strict: input.strict,
        showIdentical: input.showIdentical,
        createdBy: input.createdBy,
        ...([input.leftSourceId, input.rightSourceId, input.projectId].some((id) => /^(git|upload):/u.test(id ?? ''))
          ? { accessOwnerUserId: input.createdBy } : {}),
      });
    } catch (error) {
      releaseSources();
      throw error;
    }
    void this.queue.enqueue(job.id, async (signal) => {
      try {
        await this.execute(job.id, signal);
      } finally {
        releaseSources();
      }
    }).catch(() => releaseSources());
    return job;
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<void> {
    await this.repository.markRunning(jobId);
    const job = await this.repository.getRequired(jobId);
    try {
      const settings = await this.settings?.get(job.createdBy);
      const result = await runCompareCommand({
        maximumComparisonFiles: settings?.maximumComparisonFiles ?? 2000,
        left: job.leftSource,
        right: job.rightSource,
        ...(job.scope === 'ALL'
          ? {
            allMetadata: true,
            ...(job.metadataType === undefined ? {} : { metadataType: job.metadataType }),
          }
          : { manifest: job.manifestPath }),
        reportDir: path.join(this.runsDirectory, job.id),
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
