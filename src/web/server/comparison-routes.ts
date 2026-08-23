import type { FastifyInstance } from 'fastify';

import type { ComparisonJob } from '../../compare/comparison-job-repository.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';

interface CreateComparisonBody {
  projectId?: string;
  manifest?: string;
  leftSourceId?: string;
  rightSourceId?: string;
  strict?: boolean;
  showIdentical?: boolean;
}

export async function registerComparisonRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/workspace', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try {
      const [orgs, projects] = await Promise.all([
        app.sfudRuntime.workspace.listOrgs(),
        Promise.resolve(app.sfudRuntime.workspace.listProjects()),
      ]);
      return reply.send({
        orgs,
        projects,
        sources: [
          ...orgs.filter((org) => org.connected).map((org) => ({
            id: org.id,
            kind: 'org' as const,
            label: org.alias,
            detail: [org.label, org.edition].filter(Boolean).join(' · '),
          })),
          ...projects.map((project) => ({
            id: `project:${project.id}`,
            kind: 'local' as const,
            label: project.displayName,
            detail: 'Local DX project',
          })),
        ],
      });
    } catch (error) {
      return reply.code(502).send({ error: {
        code: 'WORKSPACE_LOAD_FAILED',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });

  app.post<{ Body: CreateComparisonBody }>('/api/v1/comparisons', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'],
    });
    if (session === undefined) return;
    try {
      const job = await app.sfudRuntime.comparisons.create({
        projectId: requiredString(request.body?.projectId, '프로젝트'),
        manifest: requiredString(request.body?.manifest, 'manifest'),
        leftSourceId: requiredString(request.body?.leftSourceId, 'LEFT 소스'),
        rightSourceId: requiredString(request.body?.rightSourceId, 'RIGHT 소스'),
        strict: request.body?.strict === true,
        showIdentical: request.body?.showIdentical === true,
        createdBy: session.user.id,
      });
      return reply.code(202).send({ job: publicJob(app, job, false) });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'INVALID_COMPARISON_REQUEST',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });

  app.get('/api/v1/comparisons', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const jobs = await app.sfudRuntime.comparisonJobs.listRecent();
    return reply.send({ jobs: jobs.map((job) => publicJob(app, job, false)) });
  });

  app.get<{ Params: { id: string } }>('/api/v1/comparisons/:id', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    const job = await app.sfudRuntime.comparisonJobs.get(request.params.id);
    if (job === undefined) {
      return reply.code(404).send({ error: { code: 'COMPARISON_NOT_FOUND', message: '비교 작업을 찾을 수 없습니다.' } });
    }
    return reply.send({ job: publicJob(app, job, true) });
  });
}

function publicJob(app: FastifyInstance, job: ComparisonJob, includeResult: boolean) {
  const left = app.sfudRuntime.workspace.publicSource(job.leftSource);
  const right = app.sfudRuntime.workspace.publicSource(job.rightSource);
  const result = includeResult && job.result !== undefined ? {
    ...job.result,
    left: { ...job.result.left, displayName: left.label },
    right: { ...job.result.right, displayName: right.label },
    components: job.showIdentical
      ? job.result.components
      : job.result.components.filter((component) => component.status !== 'IDENTICAL'),
  } : undefined;
  return {
    id: job.id,
    status: job.status,
    projectId: app.sfudRuntime.workspace.publicSource(`local:${job.projectPath}`).id.replace(/^project:/u, ''),
    manifest: app.sfudRuntime.workspace.publicManifest(job.projectPath, job.manifestPath),
    left,
    right,
    strict: job.strict,
    showIdentical: job.showIdentical,
    ...(job.result === undefined ? {} : { summary: job.result.summary }),
    ...(result === undefined ? {} : { result }),
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
