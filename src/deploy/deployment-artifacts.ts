import type { ComparisonResult } from '../metadata/comparator.js';
import { readCompressedJsonArtifact } from '../storage/json-artifact.js';
import type { DeploymentJob } from './deployment-job-model.js';

export async function hydrateArtifacts(job: DeploymentJob): Promise<DeploymentJob> {
  if (job.runDirectory === undefined) return job;
  const [comparisonArtifact, dryRunArtifact, deploymentArtifact] = await Promise.all([
    loadArtifact(job.runDirectory, job.comparisonArtifactPath, job.comparisonResult),
    loadArtifact(job.runDirectory, job.dryRunArtifactPath, job.dryRunResult),
    loadArtifact(job.runDirectory, job.deploymentArtifactPath, job.deploymentResult),
  ]);
  const comparisonResult = comparisonArtifact.value as ComparisonResult | undefined;
  const dryRunResult = dryRunArtifact.value;
  const deploymentResult = deploymentArtifact.value;
  const artifactsExpired = comparisonArtifact.expired || dryRunArtifact.expired || deploymentArtifact.expired;
  return {
    ...job,
    ...(comparisonResult === undefined ? {} : { comparisonResult }),
    ...(dryRunResult === undefined ? {} : { dryRunResult }),
    ...(deploymentResult === undefined ? {} : { deploymentResult }),
    ...(job.comparisonSummary === undefined && comparisonResult?.summary === undefined
      ? {}
      : { comparisonSummary: job.comparisonSummary ?? comparisonResult!.summary }),
    ...(artifactsExpired ? { artifactsExpired: true } : {}),
  };
}

async function loadArtifact<T>(
  runDirectory: string,
  artifactPath: string | undefined,
  inlineValue: T | undefined,
): Promise<{ value: T | undefined; expired: boolean }> {
  if (inlineValue !== undefined || artifactPath === undefined) {
    return { value: inlineValue, expired: false };
  }
  try {
    return { value: await readCompressedJsonArtifact<T>(runDirectory, artifactPath), expired: false };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { value: undefined, expired: true };
    }
    throw error;
  }
}
