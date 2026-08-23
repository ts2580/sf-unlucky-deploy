import path from 'node:path';

import { runCompareCommand } from '../commands/compare.js';
import { SfudError } from '../core/errors.js';
import { redactSensitiveText, type SfClient } from '../salesforce/sf-client.js';
import { SingleJobQueue } from '../deploy/single-job-queue.js';
import { ComparisonJobRepository, type ComparisonJob } from './comparison-job-repository.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';

export interface CreateComparisonInput {
  projectId: string;
  manifest: string;
  leftSourceId: string;
  rightSourceId: string;
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
    const [{ project, path: manifestPath }, leftSource, rightSource] = await Promise.all([
      this.workspace.resolveManifest(input.projectId, input.manifest),
      this.workspace.resolveSource(input.leftSourceId),
      this.workspace.resolveSource(input.rightSourceId),
    ]);
    if (leftSource === rightSource) throw new Error('서로 다른 비교 소스를 선택하세요.');
    const job = await this.repository.create({
      projectPath: project.realPath,
      manifestPath,
      leftSource,
      rightSource,
      strict: input.strict,
      showIdentical: input.showIdentical,
      createdBy: input.createdBy,
    });
    void this.queue.enqueue(job.id, async () => this.execute(job.id)).catch(() => undefined);
    return job;
  }

  private async execute(jobId: string): Promise<void> {
    await this.repository.markRunning(jobId);
    const job = await this.repository.getRequired(jobId);
    try {
      const result = await runCompareCommand({
        left: job.leftSource,
        right: job.rightSource,
        manifest: job.manifestPath,
        reportDir: path.join(this.runsDirectory, job.id),
        strict: job.strict,
        showIdentical: job.showIdentical,
        color: false,
      }, {
        cwd: job.projectPath,
        sfClient: this.sfClient,
        stdout: () => undefined,
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
