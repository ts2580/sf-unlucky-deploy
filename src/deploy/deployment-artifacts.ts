import type { ComparisonResult } from '../metadata/comparator.js';
import { readCompressedJsonArtifact } from '../storage/json-artifact.js';
import type { DeploymentJob } from './deployment-job-model.js';

export async function hydrateArtifacts(job: DeploymentJob): Promise<DeploymentJob> {
  if (job.runDirectory === undefined) return job;
  const [comparisonResult, dryRunResult, deploymentResult] = await Promise.all([
    job.comparisonResult !== undefined || job.comparisonArtifactPath === undefined
      ? Promise.resolve(job.comparisonResult)
      : readCompressedJsonArtifact<ComparisonResult>(job.runDirectory, job.comparisonArtifactPath),
    job.dryRunResult !== undefined || job.dryRunArtifactPath === undefined
      ? Promise.resolve(job.dryRunResult)
      : readCompressedJsonArtifact<unknown>(job.runDirectory, job.dryRunArtifactPath),
    job.deploymentResult !== undefined || job.deploymentArtifactPath === undefined
      ? Promise.resolve(job.deploymentResult)
      : readCompressedJsonArtifact<unknown>(job.runDirectory, job.deploymentArtifactPath),
  ]);
  return {
    ...job,
    ...(comparisonResult === undefined ? {} : { comparisonResult }),
    ...(dryRunResult === undefined ? {} : { dryRunResult }),
    ...(deploymentResult === undefined ? {} : { deploymentResult }),
    ...(job.comparisonSummary === undefined && comparisonResult?.summary === undefined
      ? {}
      : { comparisonSummary: job.comparisonSummary ?? comparisonResult!.summary }),
  };
}
