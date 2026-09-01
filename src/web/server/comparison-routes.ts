import type { FastifyInstance } from 'fastify';

import type { ComparisonJob } from '../../compare/comparison-job-repository.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { hasTestClassSuffix } from '../../deploy/test-plan.js';
import { requireAuthenticatedSession } from './auth-routes.js';

interface CreateComparisonBody {
  projectId?: string;
  scope?: 'manifest' | 'all';
  manifest?: string;
  leftSourceId?: string;
  rightSourceId?: string;
  strict?: boolean;
  showIdentical?: boolean;
  metadataType?: string;
}

interface MetadataTypesQuery {
  sourceIds?: string;
}

interface ApexTestClassesQuery {
  sourceId?: string;
}

export async function registerComparisonRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/workspace', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try {
      const [orgs, projects, uploads] = await Promise.all([
        app.sfudRuntime.workspace.listOrgs(),
        Promise.resolve(app.sfudRuntime.workspace.listProjects()),
        Promise.resolve(app.sfudRuntime.workspace.listUploadedProjects(session.user.id)),
      ]);
      return reply.send({
        orgs,
        projects,
        uploads,
        sources: [
          ...orgs.filter((org) => org.connected).map((org) => ({
            id: org.id,
            kind: 'org' as const,
            location: 'org' as const,
            label: org.alias,
            detail: [org.label, org.edition].filter(Boolean).join(' · '),
          })),
          ...projects.map((project) => ({
            id: `project:${project.id}`,
            kind: 'local' as const,
            location: 'server' as const,
            label: project.displayName,
            detail: '서버에 명시적으로 등록된 DX 프로젝트',
          })),
          ...uploads.map((project) => ({
            id: `upload:${project.id}`,
            kind: 'local' as const,
            location: 'upload' as const,
            label: project.displayName,
            detail: '내 단말기에서 임시 업로드 · 마지막 사용 후 4시간',
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

  app.get<{ Querystring: MetadataTypesQuery }>('/api/v1/metadata-types', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try {
      const sourceIds = (request.query.sourceIds ?? '').split(',').filter((value) => value.length > 0);
      if (sourceIds.length > 2) throw new Error('metadata type 조회 소스는 최대 2개입니다.');
      const metadataTypes = await app.sfudRuntime.workspace.listMetadataTypes(sourceIds, session.user.id);
      return reply.send({ metadataTypes });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'METADATA_TYPES_LOAD_FAILED',
        message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      } });
    }
  });

  app.get<{ Querystring: ApexTestClassesQuery }>('/api/v1/apex-test-classes', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try {
      const sourceId = requiredString(request.query.sourceId, '배포 소스');
      const settings = await app.sfudRuntime.settings.get(session.user.id);
      const testClasses = (await app.sfudRuntime.workspace.listApexTestClasses(sourceId, session.user.id))
        .filter((className) => hasTestClassSuffix(className, settings.testClassSuffix));
      return reply.send({ testClasses });
    } catch (error) {
      return reply.code(400).send({ error: {
        code: 'APEX_TEST_CLASSES_LOAD_FAILED',
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
      const scope = comparisonScope(request.body?.scope);
      const job = await app.sfudRuntime.comparisons.create({
        ...(scope === 'manifest'
          ? { projectId: requiredString(request.body?.projectId, 'manifest 프로젝트') }
          : {}),
        scope,
        ...(request.body?.manifest === undefined ? {} : { manifest: request.body.manifest }),
        ...(request.body?.metadataType === undefined
          ? {}
          : { metadataType: requiredMetadataType(request.body.metadataType) }),
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
    scope: job.scope === 'ALL' ? 'all' : 'manifest',
    ...(job.metadataType === undefined ? {} : { metadataType: job.metadataType }),
    manifest: job.scope === 'ALL'
      ? job.metadataType ?? '전체 배포 가능 메타데이터 (SF CLI)'
      : app.sfudRuntime.workspace.publicManifest(job.projectPath, job.manifestPath),
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

function comparisonScope(value: unknown): 'manifest' | 'all' {
  if (value === undefined || value === 'manifest') return 'manifest';
  if (value === 'all') return 'all';
  throw new Error('지원하지 않는 비교 범위입니다.');
}

function requiredMetadataType(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error('Salesforce metadata type이 올바르지 않습니다.');
  }
  return value;
}
