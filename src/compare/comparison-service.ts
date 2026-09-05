import path from 'node:path';

import { runCompareCommand } from '../commands/compare.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import { SingleJobQueue } from '../deploy/single-job-queue.js';
import { ComparisonJobRepository, type ComparisonJob } from './comparison-job-repository.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';

export interface CreateComparisonInput {
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
  ) {}

  public async create(input: CreateComparisonInput): Promise<ComparisonJob> {
    this.queue.assertAccepting();
    const scope = input.scope ?? 'manifest';
    const rightSource = await this.workspace.resolveSource(input.rightSourceId, input.createdBy);
    const leftSource = input.sourceOnly === true
      ? rightSource
      : await this.workspace.resolveSource(input.leftSourceId, input.createdBy);
    const project = scope === 'all'
      ? this.workspace.projectForSources(input.sourceOnly === true ? [rightSource] : [leftSource, rightSource])
      : await this.workspace.resolveProject(requiredProjectId(input.projectId));
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
      )).path;
    const releaseSources = this.workspace.pinSources(
      input.sourceOnly === true ? [input.rightSourceId] : [input.leftSourceId, input.rightSourceId],
      input.createdBy,
    );
    let job: ComparisonJob;
    try {
      this.queue.assertAccepting();
      job = await this.repository.create({
        scope: scope === 'all' ? 'ALL' : 'MANIFEST',
        ...(input.metadataType === undefined ? {} : { metadataType: input.metadataType }),
        projectPath: project.realPath,
        manifestPath,
        leftSource,
        rightSource,
        strict: input.strict,
        showIdentical: input.showIdentical,
        createdBy: input.createdBy,
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
      const result = await runCompareCommand({
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
