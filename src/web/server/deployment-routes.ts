import type { FastifyInstance } from 'fastify';

import { SfudError } from '../../core/errors.js';
import type { DeploymentJob } from '../../deploy/deployment-job-repository.js';
import type { RequestedTestLevel } from '../../deploy/test-plan.js';
import { apexCoverageSummary } from '../../deploy/test-coverage.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';

interface CreateDryRunBody {
  projectId?: string;
  scope?: 'manifest' | 'all' | 'selected';
  metadataType?: string;
  manifest?: string;
  components?: unknown;
  sourceId?: string;
  targetOrgId?: string;
  testLevel?: RequestedTestLevel;
  tests?: unknown;
  waitMinutes?: number;
  strict?: boolean;
}

interface ExecuteDeploymentBody {
  dryRunJobId?: string;
  payloadChecksum?: string;
  targetAlias?: string;
  confirmation?: string;
}

interface CreateDirectDeploymentBody extends CreateDryRunBody {
  targetConfirmation?: string;
  confirmation?: string;
}

export async function registerDeploymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateDryRunBody }>('/api/v1/deployments/dry-run', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      const settings = await app.sfudRuntime.settings.get(session.user.id);
      const job = await app.sfudRuntime.dryRuns.create({
        ...(request.body?.projectId === undefined ? {} : { projectId: request.body.projectId }),
        ...(request.body?.manifest === undefined ? {} : { manifest: request.body.manifest }),
        scope: request.body?.scope ?? 'manifest',
        ...(request.body?.metadataType === undefined ? {} : {
          metadataType: requiredMetadataType(request.body.metadataType),
        }),
        ...(request.body?.components === undefined ? {} : {
          components: selectedComponents(request.body.components),
        }),
        sourceId: requiredString(request.body?.sourceId, '배포 소스'),
        targetOrgId: requiredString(request.body?.targetOrgId, '대상 org'),
        testLevel: request.body?.testLevel ?? 'auto',
        tests: optionalStringArray(request.body?.tests, 'Apex 테스트 클래스'),
        testClassSuffix: settings.testClassSuffix,
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

  app.post<{ Body: ExecuteDeploymentBody }>('/api/v1/deployments/execute', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      const job = await app.sfudRuntime.deployments.approveAndExecute({
        dryRunJobId: requiredString(request.body?.dryRunJobId, 'dry-run 작업'),
        payloadChecksum: requiredString(request.body?.payloadChecksum, 'payload checksum'),
        targetAlias: requiredString(request.body?.targetAlias, '대상 org 별칭'),
        confirmation: requiredString(request.body?.confirmation, '실제 배포 확인 문구'),
        approvedBy: session.user.id,
      });
      return reply.code(202).send({ job: publicJob(app, job, false) });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'DEPLOYMENT_APPROVAL_DENIED',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });

  app.post<{ Body: CreateDirectDeploymentBody }>('/api/v1/deployments/direct', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      const clientRequestId = idempotencyKey(request.headers['idempotency-key']);
      const settings = await app.sfudRuntime.settings.get(session.user.id);
      const result = await app.sfudRuntime.dryRuns.createDirect({
        ...(request.body?.projectId === undefined ? {} : { projectId: request.body.projectId }),
        ...(request.body?.manifest === undefined ? {} : { manifest: request.body.manifest }),
        scope: request.body?.scope ?? 'manifest',
        ...(request.body?.metadataType === undefined ? {} : {
          metadataType: requiredMetadataType(request.body.metadataType),
        }),
        ...(request.body?.components === undefined ? {} : {
          components: selectedComponents(request.body.components),
        }),
        sourceId: requiredString(request.body?.sourceId, '배포 소스'),
        targetOrgId: requiredString(request.body?.targetOrgId, '대상 org'),
        testLevel: request.body?.testLevel ?? 'auto',
        tests: optionalStringArray(request.body?.tests, 'Apex 테스트 클래스'),
        testClassSuffix: settings.testClassSuffix,
        waitMinutes: request.body?.waitMinutes ?? 60,
        strict: request.body?.strict === true,
        targetConfirmation: requiredString(request.body?.targetConfirmation, '대상 org 별칭 확인'),
        confirmation: requiredString(request.body?.confirmation, '실제 배포 확인 문구'),
        clientRequestId,
        createdBy: session.user.id,
      });
      return reply.code(result.created ? 202 : 200).send({ job: publicJob(app, result.job, false) });
    } catch (error) {
      const conflict = error instanceof SfudError && error.code === 'IDEMPOTENCY_CONFLICT';
      return reply.code(conflict ? 409 : 400).send({ error: {
        code: conflict ? 'IDEMPOTENCY_CONFLICT' : 'DIRECT_DEPLOYMENT_DENIED',
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

  app.post<{ Params: { id: string } }>(
    '/api/v1/deployment-jobs/:id/reconcile',
    async (request, reply) => {
      const session = await requireAuthenticatedSession(app, request, reply, {
        csrf: true,
        roles: ['DEPLOYER', 'ADMIN'],
      });
      if (session === undefined) return;
      try {
        const job = await app.sfudRuntime.deployments.reconcile(request.params.id, session.user.id);
        return reply.send({ job: publicJob(app, job, true) });
      } catch (error) {
        return reply.code(400).send({ error: {
          code: 'DEPLOYMENT_RECONCILIATION_FAILED',
          message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        } });
      }
    },
  );
}

function publicJob(app: FastifyInstance, job: DeploymentJob, includeArtifacts: boolean) {
  const source = app.sfudRuntime.workspace.publicSource(job.source);
  const target = app.sfudRuntime.workspace.publicSource(`org:${job.targetAlias}`);
  const comparison = includeArtifacts && job.comparisonResult !== undefined ? {
    ...job.comparisonResult,
    left: { ...job.comparisonResult.left, displayName: target.label },
    right: { ...job.comparisonResult.right, displayName: source.label },
  } : undefined;
  const testCoverage = job.dryRunResult === undefined
    ? undefined
    : apexCoverageSummary(job.dryRunResult)?.minimumPercentage;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    source,
    target,
    manifest: job.scope === 'ALL'
      ? job.metadataType ?? '전체 메타데이터'
      : app.sfudRuntime.workspace.publicManifest(
        job.source.startsWith('local:') ? job.source.slice('local:'.length) : process.cwd(),
        job.manifestPath,
      ),
    scope: job.scope === 'ALL' ? 'all' : job.selectedComponents === undefined ? 'manifest' : 'selected',
    ...(job.metadataType === undefined ? {} : { metadataType: job.metadataType }),
    ...(job.selectedComponents === undefined ? {} : { components: job.selectedComponents }),
    prepared: job.prepared,
    ...(job.prepared ? { payloadChecksum: job.payloadChecksum } : {}),
    ...(job.salesforceDeploymentId === undefined ? {} : { salesforceDeploymentId: job.salesforceDeploymentId }),
    remoteStatus: job.remoteStatus,
    ...(job.persistenceWarning === undefined ? {} : { persistenceWarning: job.persistenceWarning }),
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    ...(job.testPlan === undefined ? {} : { testPlan: job.testPlan }),
    ...(testCoverage === undefined ? {} : { testCoverage }),
    ...(job.comparisonResult === undefined ? {} : { comparisonSummary: job.comparisonResult.summary }),
    ...(comparison === undefined ? {} : { comparison }),
    ...(includeArtifacts && job.dryRunResult !== undefined ? { dryRunResult: job.dryRunResult } : {}),
    ...(includeArtifacts && job.deploymentResult !== undefined ? { deploymentResult: job.deploymentResult } : {}),
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

function idempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(value)) {
    throw new Error('유효한 Idempotency-Key 헤더가 필요합니다.');
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label}는 문자열 배열이어야 합니다.`);
  }
  return value;
}

function requiredMetadataType(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error('Salesforce metadata type이 올바르지 않습니다.');
  }
  return value;
}

function selectedComponents(value: unknown): Array<{ type: string; fullName: string }> {
  if (!Array.isArray(value)) throw new Error('배포 대상 항목은 배열이어야 합니다.');
  return value.map((entry) => {
    if (
      typeof entry !== 'object'
      || entry === null
      || !('type' in entry)
      || !('fullName' in entry)
      || typeof entry.type !== 'string'
      || typeof entry.fullName !== 'string'
    ) {
      throw new Error('배포 대상 항목 형식이 올바르지 않습니다.');
    }
    return { type: entry.type, fullName: entry.fullName };
  });
}
