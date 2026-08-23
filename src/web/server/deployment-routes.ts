import type { FastifyInstance } from 'fastify';

import type { DeploymentJob } from '../../deploy/deployment-job-repository.js';
import type { RequestedTestLevel } from '../../deploy/test-plan.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';

interface CreateDryRunBody {
  projectId?: string;
  manifest?: string;
  sourceId?: string;
  targetOrgId?: string;
  testLevel?: RequestedTestLevel;
  tests?: unknown;
  waitMinutes?: number;
  strict?: boolean;
}

export async function registerDeploymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateDryRunBody }>('/api/v1/deployments/dry-run', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      const job = await app.sfudRuntime.dryRuns.create({
        projectId: requiredString(request.body?.projectId, '프로젝트'),
        manifest: requiredString(request.body?.manifest, 'manifest'),
        sourceId: requiredString(request.body?.sourceId, '배포 소스'),
        targetOrgId: requiredString(request.body?.targetOrgId, '대상 org'),
        testLevel: request.body?.testLevel ?? 'auto',
        tests: optionalStringArray(request.body?.tests, 'Apex 테스트 클래스'),
        waitMinutes: request.body?.waitMinutes ?? 60,
        strict: request.body?.strict === true,
        createdBy: session.user.id,
      });
      return reply.code(202).send({ job: publicJob(app, job, false) });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'INVALID_DRY_RUN_REQUEST',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });

  app.get('/api/v1/deployment-jobs', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const jobs = await app.sfudRuntime.deploymentJobs.listRecent();
    return reply.send({ jobs: jobs.map((job) => publicJob(app, job, false)) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/deployment-jobs/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const job = await app.sfudRuntime.deploymentJobs.get(request.params.id);
    if (job === undefined) {
      return reply.code(404).send({ error: { code: 'DEPLOYMENT_JOB_NOT_FOUND', message: '배포 작업을 찾을 수 없습니다.' } });
    }
    return reply.send({ job: publicJob(app, job, true) });
  });
}

function publicJob(app: FastifyInstance, job: DeploymentJob, includeArtifacts: boolean) {
  const source = app.sfudRuntime.workspace.publicSource(job.source);
  const target = app.sfudRuntime.workspace.publicSource(`org:${job.targetAlias}`);
  const comparison = includeArtifacts && job.comparisonResult !== undefined ? {
    ...job.comparisonResult,
    left: { ...job.comparisonResult.left, displayName: target.label },
    right: { ...job.comparisonResult.right, displayName: source.label },
  } : undefined;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    source,
    target,
    manifest: app.sfudRuntime.workspace.publicManifest(
      job.source.startsWith('local:') ? job.source.slice('local:'.length) : process.cwd(),
      job.manifestPath,
    ),
    prepared: job.prepared,
    ...(job.prepared ? { payloadChecksum: job.payloadChecksum } : {}),
    ...(job.salesforceDeploymentId === undefined ? {} : { salesforceDeploymentId: job.salesforceDeploymentId }),
    ...(job.testPlan === undefined ? {} : { testPlan: job.testPlan }),
    ...(job.comparisonResult === undefined ? {} : { comparisonSummary: job.comparisonResult.summary }),
    ...(comparison === undefined ? {} : { comparison }),
    ...(includeArtifacts && job.dryRunResult !== undefined ? { dryRunResult: job.dryRunResult } : {}),
    ...(job.errorCode === undefined ? {} : { errorCode: job.errorCode }),
    ...(job.errorMessage === undefined ? {} : { errorMessage: job.errorMessage }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 선택이 필요합니다.`);
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label}는 문자열 배열이어야 합니다.`);
  }
  return value;
}
