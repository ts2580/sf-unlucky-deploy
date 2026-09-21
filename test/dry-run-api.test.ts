import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { SfudError } from '../src/core/errors.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from './support/files.js';

describe('dry-run API', () => {
  it('보호된 실행 기록이 run quota를 넘으면 source 준비 전 새 요청을 503으로 거부한다', async () => {
    vi.stubEnv('SFUD_RUN_MAX_BYTES', '1');
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const protectedJob = await fixture.server.sfudRuntime.deploymentJobs.createDryRun({
        source: `local:${fixture.projectPath}`, targetAlias: 'target', manifestPath: '@all', payloadChecksum: 'a'.repeat(64),
        createdBy: (await fixture.server.sfudRuntime.store.database.get<{ id: string }>('SELECT id FROM users LIMIT 1'))!.id,
        targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
      });
      const payloadDirectory = path.join(fixture.root, 'data', 'runs', protectedJob.id);
      await mkdir(payloadDirectory, { recursive: true });
      await writeFile(path.join(payloadDirectory, 'protected.bin'), Buffer.alloc(2));
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const callsBefore = fixture.client.calls.length;

      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'run-storage-full' },
        payload: {
          projectId: workspace.projects[0]!.id, manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', testLevel: 'RunLocalTests', tests: [], waitMinutes: 10, strict: false,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'REQUEST_CAPACITY_EXCEEDED' } });
      expect(fixture.client.calls).toHaveLength(callsBefore);
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM deployment_jobs'))
        .toEqual({ count: 1 });
    } finally {
      vi.unstubAllEnvs();
      await fixture.close();
    }
  });

  it('queue 예약이 가득 차도 durable admission lease를 남기지 않는다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    const reservations = Array.from({ length: 20 }, () => fixture.server.sfudRuntime.deploymentCoordinator.reserveQueueSlot());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'queue-reservation-full' },
        payload: {
          projectId: workspace.projects[0]!.id, manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', testLevel: 'RunLocalTests', tests: [], waitMinutes: 10, strict: false,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'REQUEST_CAPACITY_EXCEEDED' } });
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM deployment_admission_leases'))
        .toEqual({ count: 0 });
    } finally {
      for (const reservation of reservations) reservation.release();
      await fixture.close();
    }
  });

  it('ADMIN 전용 원격 ID 연결은 report의 ID와 checkOnly를 대조하고 감사 기록을 남긴다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const admin = await fixture.server.sfudRuntime.store.database.get<{ id: string }>('SELECT id FROM users LIMIT 1');
      const created = await fixture.server.sfudRuntime.deploymentJobs.createDirectDeployment({
        source: `local:${fixture.projectPath}`, targetAlias: 'target', manifestPath: 'manifest/package.xml',
        payloadChecksum: 'a'.repeat(64), requestHash: 'a'.repeat(64), clientRequestId: 'manual-reconcile-job',
        createdBy: admin!.id, accessOwnerUserId: admin!.id, requestedTestLevel: 'RunLocalTests', requestedTests: [],
        targetConfirmation: 'target', confirmation: '실제 배포',
        targetOrgIdentity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' },
      });
      await fixture.server.sfudRuntime.deploymentJobs.transition(created.job.id, 'DEPLOYING');
      await fixture.server.sfudRuntime.deploymentJobs.attempts.begin({
        jobId: created.job.id, operation: 'VALIDATE', payloadChecksum: 'a'.repeat(64), digestVersion: 1,
        runDirectory: fixture.projectPath,
      });
      await fixture.server.sfudRuntime.deploymentJobs.recoverInterruptedJobs();

      const response = await fixture.server.inject({
        method: 'POST', url: `/api/v1/deployment-jobs/${created.job.id}/manual-reconcile`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          deploymentId: '0Af000000000001', operation: 'VALIDATE', observedAt: new Date().toISOString(),
          evidence: 'Salesforce Deployment Status report의 대상 org, 실행 ID, 제출 시각을 확인했습니다.',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ job: {
        status: 'VALIDATED_PENDING_EXECUTION', salesforceDeploymentId: '0Af000000000001',
      } });
      expect(await fixture.server.sfudRuntime.store.database.get(`
        SELECT COUNT(*) count FROM audit_events
        WHERE entity_id = ? AND event_type = 'DEPLOYMENT_ATTEMPT_MANUALLY_BOUND'
      `, created.job.id)).toEqual({ count: 1 });
    } finally { await fixture.close(); }
  });

  it('허용된 source를 check-only로 검증하고 payload와 테스트 결과를 영속화한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const savedSettings = await fixture.server.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: { testClassSuffix: 'Spec' },
      });
      expect(savedSettings.statusCode).toBe(200);
      expect(savedSettings.json()).toEqual({ settings: { testClassSuffix: 'Spec', maximumComparisonFiles: 2000 } });
      expect((await fixture.server.inject({
        url: '/api/v1/settings', headers: { cookie: auth.cookie },
      })).json()).toEqual({ settings: { testClassSuffix: 'Spec', maximumComparisonFiles: 2000 } });
      const invalidSettings = await fixture.server.inject({
        method: 'PUT',
        url: '/api/v1/settings',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: { testClassSuffix: '-invalid' },
      });
      expect(invalidSettings.statusCode).toBe(400);
      expect(invalidSettings.json()).toMatchObject({ error: { code: 'INVALID_SETTINGS_REQUEST' } });
      const workspace = await fixture.server.inject({ url: '/api/v1/workspace', headers: { cookie: auth.cookie } });
      const body = workspace.json<{
        projects: Array<{ id: string }>;
        sources: Array<{ id: string; kind: string }>;
      }>();
      const projectId = body.projects[0]!.id;
      const sourceId = body.sources.find((source) => source.kind === 'local')!.id;

      const created = await fixture.server.inject({
        method: 'POST',
        url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-basic' },
        payload: {
          projectId,
          manifest: 'manifest/package.xml',
          sourceId,
          targetOrgId: 'org:target',
          testLevel: 'auto',
          tests: [],
          waitMinutes: 10,
          strict: false,
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const response = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`,
        headers: { cookie: auth.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        job: {
          status: 'APPROVAL_PENDING',
          remoteStatus: 'SUCCEEDED',
          prepared: true,
          source: { kind: 'local', label: 'project' },
          target: { id: 'org:target', label: 'target' },
          manifest: 'manifest/package.xml',
          payloadChecksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
          salesforceDeploymentId: '0Af-check-only',
          progress: {
            phase: 'DRY_RUN', status: 'Succeeded', done: true,
            numberComponentsDeployed: 2, numberComponentsTotal: 2,
            numberTestsCompleted: 1, numberTestsTotal: 1,
          },
          testPlan: { level: 'RunSpecifiedTests', tests: ['HelloSpec'], selection: 'suffix' },
          comparisonSummary: { modified: 1 },
        },
      });
      expect(response.body).not.toContain('must-not-leak');
      expect(response.body).not.toContain(fixture.projectPath);
      const storedJob = await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId);
      await rm(storedJob.runDirectory!, { recursive: true, force: true });
      const expiredDetails = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}/artifacts`,
        headers: { cookie: auth.cookie },
      });
      expect(expiredDetails.statusCode).toBe(200);
      expect(expiredDetails.json()).toMatchObject({ job: {
        id: jobId,
        status: 'APPROVAL_PENDING',
        artifactsExpired: true,
      } });
      expect(expiredDetails.body).not.toContain('"comparison"');
      expect(expiredDetails.body).not.toContain('"dryRunResult"');
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(1);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      expect(deployCalls[0]!.args).toEqual(expect.arrayContaining([
        '--test-level', 'RunSpecifiedTests', '--tests', 'HelloSpec', '--async',
      ]));
      expect(deployCalls[0]!.args).not.toContain('--wait');
      expect(fixture.client.calls.some((call) => call.args.slice(0, 3).join(' ') === 'project deploy report')).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('전체 metadata 범위를 동적으로 생성해 비교와 check-only에 동일하게 사용한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;

      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-all' },
        payload: {
          scope: 'all', metadataType: 'ApexClass', sourceId, targetOrgId: 'org:target',
          testLevel: 'RunLocalTests', waitMinutes: 10,
        },
      });
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ job: {
        scope: 'all', metadataType: 'ApexClass', manifest: 'ApexClass',
      } });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const job = (await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`, headers: { cookie: auth.cookie },
      })).json<{ job: { status: string; comparisonSummary: { modified: number } } }>().job;
      expect(job).toMatchObject({ status: 'APPROVAL_PENDING', comparisonSummary: { modified: 1 } });
      const manifestCalls = fixture.client.calls.filter((call) =>
        call.args[0] === 'project' && call.args[1] === 'generate' && call.args[2] === 'manifest');
      expect(manifestCalls).toHaveLength(2);
      expect(manifestCalls[0]!.args).toEqual(expect.arrayContaining(['--metadata', 'ApexClass']));
      expect(fixture.client.calls.find((call) => call.args.includes('deploy'))?.args).toContain('--dry-run');
    } finally {
      await fixture.close();
    }
  });

  it.each([1, 2000])('비교 상한 %i에서 선택한 metadata만 검증하고 승인된 동일 payload를 배포한다', async (maximumComparisonFiles) => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const submitAuthorization = vi.spyOn(fixture.server.sfudRuntime.deploymentJobs, 'assertAccess');
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      await fixture.server.inject({ method: 'PUT', url: '/api/v1/settings',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: { testClassSuffix: '_Test', maximumComparisonFiles } });
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-selected' },
        payload: {
          scope: 'selected',
          components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId,
          targetOrgId: 'org:target',
          testLevel: 'RunLocalTests',
        },
      });
      expect(created.statusCode).toBe(202);
      expect(created.json()).toMatchObject({ job: {
        scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
      } });
      const dryRunId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      const dryRun = await fixture.server.sfudRuntime.deploymentJobs.getRequired(dryRunId);
      expect(dryRun).toMatchObject({ status: 'APPROVAL_PENDING', prepared: true,
        comparisonLimit: { maximumFiles: maximumComparisonFiles, exceeded: maximumComparisonFiles === 1 } });
      const recentJobs = (await fixture.server.inject({
        url: '/api/v1/deployment-jobs', headers: { cookie: auth.cookie },
      })).json<{ jobs: Array<{ id: string; scope?: string; components?: unknown[] }> }>().jobs;
      expect(recentJobs.find((job) => job.id === dryRunId)).toMatchObject({
        scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
      });
      expect(dryRun.manifestPath).toBe(path.join(
        fixture.root, 'data', 'runs', dryRun.id, 'input', 'package.xml',
      ));
      expect(await readFile(dryRun.manifestPath, 'utf8')).toContain('<members>Hello</members>');
      expect(await readFile(dryRun.manifestPath, 'utf8')).not.toContain('<members>Hello_Test</members>');
      const retry = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-selected' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }], sourceId,
          targetOrgId: 'org:target', testLevel: 'RunLocalTests',
        },
      });
      expect(retry.json<{ job: { id: string } }>().job.id).toBe(dryRun.id);
      expect(await readdir(path.join(fixture.root, 'data', 'runs'))).toEqual([dryRun.id]);

      const approved = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/execute',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          dryRunJobId: dryRun.id,
          payloadChecksum: dryRun.payloadChecksum,
          targetAlias: 'target',
          confirmation: '실제 배포',
        },
      });
      expect(approved.statusCode).toBe(202);
      expect(approved.json()).toMatchObject({ job: {
        prepared: true,
        payloadChecksum: dryRun.payloadChecksum,
        comparisonLimit: { maximumFiles: maximumComparisonFiles, exceeded: maximumComparisonFiles === 1 },
        testPlan: { level: 'RunLocalTests' },
      } });
      const deploymentId = approved.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(deploymentId)).toMatchObject({
        kind: 'DEPLOY', status: 'SUCCEEDED', prepared: true,
        testPlan: { level: 'RunLocalTests' },
        selectedComponents: [{ type: 'ApexClass', fullName: 'Hello' }],
        executionMode: 'QUICK_DEPLOY', reusedValidationId: '0Af-check-only',
      });
      expect((await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${deploymentId}`, headers: { cookie: auth.cookie },
      })).json()).toMatchObject({ job: {
        executionMode: 'QUICK_DEPLOY', reusedValidationId: '0Af-check-only',
      } });
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(1);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      const quickCalls = fixture.client.calls.filter((call) =>
        call.args[0] === 'project' && call.args[1] === 'deploy' && call.args[2] === 'quick');
      expect(quickCalls).toHaveLength(1);
      expect(quickCalls[0]!.args).toEqual(expect.arrayContaining(['--job-id', '0Af-check-only', '--target-org', 'target', '--async']));
      expect(quickCalls[0]!.args).not.toContain('--use-most-recent');
      expect(submitAuthorization).toHaveBeenCalledWith(deploymentId, expect.any(String));
    } finally {
      await fixture.close();
    }
  });

  it('Quick Deploy 운영 제어를 끄면 일반 배포로 대체 제출하지 않는다', async () => {
    const fixture = await createFixture(new DryRunSfClient(), { quickDeployEnabled: false });
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const dryRunResponse = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'quick-disabled-dry-run' },
        payload: { scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }], sourceId, targetOrgId: 'org:target', testLevel: 'RunLocalTests' },
      });
      const dryRunId = dryRunResponse.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      const dryRun = await fixture.server.sfudRuntime.deploymentJobs.getRequired(dryRunId);
      const approved = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/execute',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: { dryRunJobId: dryRun.id, payloadChecksum: dryRun.payloadChecksum, targetAlias: 'target', confirmation: '실제 배포' },
      });
      const deployId = approved.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(deployId)).toMatchObject({
        status: 'FAILED', errorCode: 'JOB_EXECUTION_FAILED', executionMode: 'REVALIDATION_REQUIRED',
        executionReason: expect.stringContaining('Quick Deploy 신규 제출을 비활성화'),
      });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);
      expect(fixture.client.calls.filter((call) => call.args[2] === 'quick')).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('테스트 미선택 직접 배포는 dry-run 없이 NoTestRun으로 실행한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-no-tests' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [], targetConfirmation: 'target',
          confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const response = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`, headers: { cookie: auth.cookie },
      });
      expect(response.json()).toMatchObject({ job: {
        kind: 'DEPLOY', status: 'SUCCEEDED', prepared: true,
        testPlan: { level: 'NoTestRun', tests: [], selection: 'configured' },
      } });
      expect((await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).dryRunJobId).toBeUndefined();
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(1);
      expect(deployCalls[0]!.args).not.toContain('--dry-run');
      expect(deployCalls[0]!.args).toEqual(expect.arrayContaining(['--test-level', 'NoTestRun']));
    } finally {
      await fixture.close();
    }
  });

  it('대상 org allowlist에서 회수된 DEPLOYER는 Salesforce 제출 직전에 차단한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      await bootstrap(fixture.server);
      const admin = await fixture.server.sfudRuntime.store.database.get<{ id: string }>('SELECT id FROM users WHERE role = ?', 'ADMIN');
      const deployer = await fixture.server.sfudRuntime.auth.createManagedUser({
        actorUserId: admin!.id, email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER',
        password: 'deployer correct horse battery staple',
      });
      await fixture.server.sfudRuntime.orgExecutionAccess.grant('target', admin!.id, admin!.id);
      const login = await fixture.server.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { email: 'deployer@example.com', password: 'deployer correct horse battery staple' },
      });
      const cookie = (login.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
      const csrfToken = login.json<{ csrfToken: string }>().csrfToken;
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie, 'x-sfud-csrf': csrfToken, 'idempotency-key': 'direct-org-allowlist-denied' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'FAILED', errorCode: 'JOB_EXECUTION_FAILED', remoteStatus: 'NOT_SUBMITTED', createdBy: deployer.id,
      });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it.each(['RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'] as const)(
    '직접 배포에서 선택한 %s를 check-only와 실제 배포에 유지한다', async (testLevel) => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': `direct-${testLevel}` },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel, tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        kind: 'DEPLOY', status: 'SUCCEEDED',
        testPlan: { level: testLevel, tests: [], selection: 'configured' },
      });
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(2);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      expect(deployCalls[1]!.args).not.toContain('--dry-run');
      for (const call of deployCalls) {
        expect(call.args).toEqual(expect.arrayContaining(['--test-level', testLevel]));
        expect(call.args).not.toContain('--tests');
      }
    } finally {
      await fixture.close();
    }
  });

  it('테스트 선택 직접 배포는 75% 커버리지를 확인한 뒤 실행한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('none', 80));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-with-tests' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'RunSpecifiedTests', tests: ['CoverageSpec'],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const response = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`, headers: { cookie: auth.cookie },
      });
      expect(response.json()).toMatchObject({ job: {
        kind: 'DEPLOY', status: 'SUCCEEDED', testCoverage: 80,
        testPlan: { level: 'RunSpecifiedTests', tests: ['CoverageSpec'] },
      } });
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(2);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      expect(deployCalls[1]!.args).not.toContain('--dry-run');
      for (const call of deployCalls) {
        expect(call.args).toEqual(expect.arrayContaining([
          '--test-level', 'RunSpecifiedTests', '--tests', 'CoverageSpec',
        ]));
      }
    } finally {
      await fixture.close();
    }
  });

  it('테스트 선택 직접 배포는 커버리지 75% 미만이면 실제 반영 전에 실패한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('none', 74));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-low-coverage' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'RunSpecifiedTests', tests: ['CoverageSpec'],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'FAILED', errorCode: 'JOB_EXECUTION_FAILED',
        errorMessage: expect.stringMatching(/74%.*75% 미만/u),
      });
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(1);
      expect(deployCalls[0]!.args).toContain('--dry-run');
    } finally {
      await fixture.close();
    }
  });

  it('진행 상태 저장이 실패해도 polling을 계속하고 원격 성공과 경고를 보존한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      vi.spyOn(fixture.server.sfudRuntime.deploymentJobs, 'recordSalesforceProgress')
        .mockRejectedValue(new Error('database locked'));

      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-progress-failure' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'SUCCEEDED',
        remoteStatus: 'SUCCEEDED',
        salesforceDeploymentId: '0Af-deploy',
        persistenceWarning: expect.stringContaining('Salesforce 진행 상태 저장 실패: database locked'),
      });
      expect(fixture.client.calls.filter((call) => call.args[2] === 'report')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });

  it('실제 배포 완료 상태 저장 실패를 재확인 가능하게 남기고 재제출 없이 복구한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const jobs = fixture.server.sfudRuntime.deploymentJobs;
      const transition = jobs.transition.bind(jobs);
      let failCompletion = true;
      vi.spyOn(jobs, 'transition').mockImplementation(async (id, status, details) => {
        if (status === 'SUCCEEDED' && failCompletion) throw new Error('database locked');
        return transition(id, status, details);
      });
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-completion-failure' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const id = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      expect(await jobs.getRequiredSummary(id)).toMatchObject({
        status: 'RECONCILE_REQUIRED', remoteStatus: 'SUCCEEDED', salesforceDeploymentId: '0Af-deploy',
      });
      failCompletion = false;
      const reconciled = await fixture.server.inject({
        method: 'POST', url: `/api/v1/deployment-jobs/${id}/reconcile`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(reconciled.json()).toMatchObject({ job: { status: 'SUCCEEDED' } });
      await fixture.server.sfudRuntime.deploymentCoordinator.flushCompletions();
      expect(fixture.client.calls.filter((call) => call.args[1] === 'deploy' && call.args[2] === 'start')).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await fixture.close(); }
  });

  it('원격 성공 뒤 상세 artifact 저장이 실패해도 작업을 FAILED로 바꾸지 않는다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      vi.spyOn(fixture.server.sfudRuntime.deploymentJobs, 'recordDirectDeploymentArtifacts')
        .mockRejectedValueOnce(new Error('artifact write failed'));

      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'direct-artifact-failure' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const response = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`, headers: { cookie: auth.cookie },
      });
      expect(response.json()).toMatchObject({ job: {
        status: 'SUCCEEDED',
        remoteStatus: 'SUCCEEDED',
        salesforceDeploymentId: '0Af-deploy',
        prepared: false,
        persistenceWarning: expect.stringContaining('배포 상세 결과 저장 실패: artifact write failed'),
      } });
      expect(response.body).not.toContain('"errorCode"');
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });

  it('같은 dry-run Idempotency-Key를 한 job과 한 번의 Salesforce 제출로 수렴시킨다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const headers = {
        cookie: auth.cookie,
        'x-sfud-csrf': auth.csrfToken,
        'idempotency-key': 'concurrent-dry-run-request',
      };
      const payload = {
        scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
        sourceId, targetOrgId: 'org:target', testLevel: 'RunLocalTests', tests: [],
      };

      const [first, duplicate] = await Promise.all([
        fixture.server.inject({ method: 'POST', url: '/api/v1/deployments/dry-run', headers, payload }),
        fixture.server.inject({ method: 'POST', url: '/api/v1/deployments/dry-run', headers, payload }),
      ]);
      expect(first.statusCode).toBe(202);
      expect(duplicate.statusCode).toBe(202);
      const jobId = first.json<{ job: { id: string } }>().job.id;
      expect(duplicate.json<{ job: { id: string } }>().job.id).toBe(jobId);
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.store.database.get(`
        SELECT COUNT(*) count FROM deployment_jobs WHERE client_request_id = ?
      `, headers['idempotency-key'])).toEqual({ count: 1 });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);

      const retry = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run', headers, payload,
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json<{ job: { id: string } }>().job.id).toBe(jobId);
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);

      const conflict = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run', headers,
        payload: { ...payload, strict: true },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    } finally {
      await fixture.close();
    }
  });

  it('Idempotency-Key가 없는 dry-run 요청을 거부한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: {
        code: 'INVALID_DRY_RUN_REQUEST',
        message: expect.stringContaining('Idempotency-Key'),
      } });
    } finally {
      await fixture.close();
    }
  });

  it('같은 직접 배포 Idempotency-Key 요청을 한 job과 한 번의 Salesforce 제출로 수렴시킨다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const headers = {
        cookie: auth.cookie,
        'x-sfud-csrf': auth.csrfToken,
        'idempotency-key': 'concurrent-direct-request',
      };
      const payload = {
        scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
        sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
        targetConfirmation: 'target', confirmation: '실제 배포',
      };

      const [first, duplicate] = await Promise.all([
        fixture.server.inject({ method: 'POST', url: '/api/v1/deployments/direct', headers, payload }),
        fixture.server.inject({ method: 'POST', url: '/api/v1/deployments/direct', headers, payload }),
      ]);
      expect([first.statusCode, duplicate.statusCode].sort()).toEqual([200, 202]);
      const jobId = first.json<{ job: { id: string } }>().job.id;
      expect(duplicate.json<{ job: { id: string } }>().job.id).toBe(jobId);
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.store.database.get(`
        SELECT COUNT(*) count FROM deployment_jobs WHERE client_request_id = ?
      `, headers['idempotency-key'])).toEqual({ count: 1 });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);

      const retry = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct', headers, payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json<{ job: { id: string } }>().job.id).toBe(jobId);
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);

      const conflict = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct', headers,
        payload: { ...payload, strict: true },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    } finally {
      await fixture.close();
    }
  });

  it('Idempotency-Key가 없는 직접 배포 요청을 거부한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: {
        code: 'DIRECT_DEPLOYMENT_DENIED',
        message: expect.stringContaining('Idempotency-Key'),
      } });
    } finally {
      await fixture.close();
    }
  });

  it('사용자별 접수 준비 한도 초과는 source 조회와 파일 생성 전에 429로 거부한다', async () => {
    const client = new GatedMetadataSfClient(1);
    const fixture = await createFixture(client);
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const request = (key: string) => fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': key },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }], sourceId,
          targetOrgId: 'org:target', testLevel: 'RunLocalTests',
        },
      });
      const first = request('admission-1');
      const second = request('admission-2');
      await client.waitForBlockedMetadata();

      const rejected = await request('admission-3');
      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toMatchObject({ error: { code: 'REQUEST_USER_LIMIT' } });
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM deployment_jobs'))
        .toEqual({ count: 0 });

      client.releaseMetadata();
      await Promise.all([first, second]);
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
    } finally {
      await fixture.close();
    }
  });

  it('queue 대기 중 target alias가 다른 org를 가리키면 제출 전에 차단한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('identity-changed'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: {
          cookie: auth.cookie,
          'x-sfud-csrf': auth.csrfToken,
          'idempotency-key': 'identity-changed-direct',
        },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'FAILED', errorCode: 'ORG_IDENTITY_CHANGED', remoteStatus: 'NOT_SUBMITTED',
      });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(0);
      const audit = await fixture.server.sfudRuntime.store.database.get<{ detail_json: string }>(`
        SELECT detail_json FROM audit_events
        WHERE entity_id = ? AND event_type = 'ORG_IDENTITY_MISMATCH'
      `, jobId);
      expect(audit?.detail_json).toContain('00D00…001');
      expect(audit?.detail_json).toContain('00D00…099');
      expect(audit?.detail_json).not.toContain('00D000000000099');
    } finally {
      await fixture.close();
    }
  });

  it('dry-run 뒤 target org identity가 바뀌면 승인 배포를 차단한다', async () => {
    const client = new DryRunSfClient();
    const fixture = await createFixture(client);
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const dryRunResponse = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-identity' },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'RunLocalTests',
        },
      });
      const dryRunId = dryRunResponse.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      const dryRun = await fixture.server.sfudRuntime.deploymentJobs.getRequired(dryRunId);
      client.orgId = '00D000000000099';

      const approved = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/execute',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          dryRunJobId: dryRun.id,
          payloadChecksum: dryRun.payloadChecksum,
          targetAlias: 'target',
          confirmation: '실제 배포',
        },
      });
      const deployId = approved.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(deployId)).toMatchObject({
        status: 'FAILED', errorCode: 'ORG_IDENTITY_CHANGED', remoteStatus: 'NOT_SUBMITTED',
      });
      expect(deploymentStartCalls(client.calls)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('제출 명령의 불명확한 실패를 민감 정보 없이 재확인 상태로 기록한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('definitive'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const created = await fixture.server.inject({
        method: 'POST',
        url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-failure' },
        payload: {
          projectId: workspace.projects[0]!.id,
          manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target',
          testLevel: 'RunLocalTests',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      const failed = await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId);
      expect(failed).toMatchObject({ status: 'RECONCILE_REQUIRED', errorCode: 'EXTERNAL_STATE_UNKNOWN' });
      expect(failed.errorMessage).not.toContain('force://client:must-not-leak');
      expect(failed.errorMessage).toContain('force://[REDACTED]');
    } finally {
      await fixture.close();
    }
  });

  it('Salesforce 실패 보고서의 테스트와 커버리지 상세를 API에 보존한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('reported'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-diagnostics' },
        payload: {
          projectId: workspace.projects[0]!.id,
          manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', testLevel: 'RunSpecifiedTests', tests: ['CryptoUtil_Test'],
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      const response = await fixture.server.inject({
        url: `/api/v1/deployment-jobs/${jobId}`, headers: { cookie: auth.cookie },
      });
      expect(response.json()).toMatchObject({ job: {
        status: 'FAILED',
        remoteStatus: 'FAILED',
        errorMessage: expect.stringMatching(/CryptoUtil_Test\.encryptsAndDecryptsWithConfiguredKey.*List has no rows/u),
        progress: { status: 'Failed', diagnostics: {
          componentFailures: [],
          testFailures: [{
            name: 'CryptoUtil_Test', methodName: 'encryptsAndDecryptsWithConfiguredKey',
            message: 'System.QueryException: List has no rows for assignment to SObject',
          }],
          codeCoverageWarnings: [{ name: 'CryptoUtil', message: expect.stringContaining('8.696%') }],
        } },
      } });
    } finally {
      await fixture.close();
    }
  });

  it('제출 응답을 잃으면 오류 문자열의 ID를 신뢰하지 않고 재확인 상태를 유지한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('ambiguous'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken, 'idempotency-key': 'dry-run-ambiguous' },
        payload: {
          projectId: workspace.projects[0]!.id, manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', testLevel: 'RunLocalTests',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();

      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'RECONCILE_REQUIRED',
        remoteStatus: 'UNKNOWN',
        errorCode: 'EXTERNAL_STATE_UNKNOWN',
      });
      expect((await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).salesforceDeploymentId).toBeUndefined();
      const reconciled = await fixture.server.inject({
        method: 'POST', url: `/api/v1/deployment-jobs/${jobId}/reconcile`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(reconciled.statusCode).toBe(400);
      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'RECONCILE_REQUIRED', remoteStatus: 'UNKNOWN',
      });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);
      expect(await fixture.server.sfudRuntime.store.database.get(`
        SELECT COUNT(*) count FROM audit_events
        WHERE entity_id = ? AND event_type = 'DEPLOYMENT_RECONCILED'
      `, jobId)).toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  });

  it('실제 배포의 불명확한 원격 상태를 report 조회만으로 성공 확정한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('report-interrupted'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: {
          cookie: auth.cookie,
          'x-sfud-csrf': auth.csrfToken,
          'idempotency-key': 'reconcile-direct-request',
        },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(jobId)).toMatchObject({
        status: 'RECONCILE_REQUIRED', remoteStatus: 'UNKNOWN',
      });

      const reconciled = await fixture.server.inject({
        method: 'POST', url: `/api/v1/deployment-jobs/${jobId}/reconcile`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(reconciled.json()).toMatchObject({ job: {
        status: 'SUCCEEDED', remoteStatus: 'SUCCEEDED',
        salesforceDeploymentId: '0Af000000000001AAA',
      } });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('실제 배포 polling 중 종료하면 ID를 보존하고 재확인 상태로 남긴다', async () => {
    const client = new AbortableDeploymentSfClient();
    const fixture = await createFixture(client);
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/direct',
        headers: {
          cookie: auth.cookie,
          'x-sfud-csrf': auth.csrfToken,
          'idempotency-key': 'shutdown-direct-request',
        },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [],
          targetConfirmation: 'target', confirmation: '실제 배포',
        },
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await client.waitForReport();

      await fixture.server.sfudRuntime.shutdown(1);

      const reopened = await openSqliteStore({
        databasePath: path.join(fixture.root, 'data', 'sfud.db'),
      });
      try {
        expect(await reopened.database.get(`
          SELECT status, remote_status remoteStatus,
            salesforce_deployment_id salesforceDeploymentId
          FROM deployment_jobs WHERE id = ?
        `, jobId)).toEqual({
          status: 'RECONCILE_REQUIRED',
          remoteStatus: 'UNKNOWN',
          salesforceDeploymentId: '0Af-deploy',
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await fixture.close();
    }
  });

  it('Apex 테스트 배열의 비문자열 원소를 작업 생성 전에 거부한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          projectId: workspace.projects[0]!.id, manifest: 'manifest/package.xml',
          sourceId: workspace.sources.find((source) => source.kind === 'local')!.id,
          targetOrgId: 'org:target', tests: [null, true],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_DRY_RUN_REQUEST' } });
      expect(deploymentStartCalls(fixture.client.calls)).toHaveLength(0);
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM deployment_jobs'))
        .toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  });

  it('waitMinutes 120분 초과 요청을 공유 API 계약에서 거부한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const response = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: {
          cookie: auth.cookie,
          'x-sfud-csrf': auth.csrfToken,
          'idempotency-key': 'dry-run-invalid-wait',
        },
        payload: { waitMinutes: 121 },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_DRY_RUN_REQUEST' } });
      expect(await fixture.server.sfudRuntime.store.database.get('SELECT COUNT(*) count FROM deployment_jobs'))
        .toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  });
});

class DryRunSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];
  public orgId = '00D000000000001';
  private orgListCalls = 0;

  public constructor(
    private readonly failure: 'none' | 'definitive' | 'ambiguous' | 'report-interrupted' | 'reported' | 'identity-changed' = 'none',
    private readonly coverage = 80,
  ) {}

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { status: 0, result: { metadataObjects: [
        { xmlName: 'ApexClass', directoryName: 'classes', suffix: 'cls' },
      ] } };
    }
    if (args[0] === 'org' && args[1] === 'list') {
      this.orgListCalls += 1;
      const orgId = this.failure === 'identity-changed' && this.orgListCalls > 1
        ? '00D000000000099'
        : this.orgId;
      return { status: 0, result: { nonScratchOrgs: [
        {
          alias: 'target', username: 'target@example.com', orgId,
          instanceUrl: 'https://target.example.my.salesforce.com', name: 'Target',
          orgEdition: 'Developer', connectedStatus: 'Connected',
        },
      ] } };
    }
    if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
      await mkdir(flagValue(args, '--output-dir'), { recursive: true });
      await writeFile(path.join(flagValue(args, '--output-dir'), flagValue(args, '--name')), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        '<types><members>Hello</members><members>Hello_Test</members><name>ApexClass</name></types>',
        '<version>67.0</version></Package>',
      ].join('\n'));
      return { status: 0 };
    }
    if (args.includes('retrieve')) {
      await writeSnapshot(flagValue(args, '--target-metadata-dir'), 'target');
      return { status: 0 };
    }
    if (args.includes('convert')) {
      await writeSnapshot(flagValue(args, '--output-dir'), 'source');
      return { status: 0 };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && ['start', 'quick'].includes(args[2]!)) {
      if (this.failure === 'definitive') {
        throw new SfudError('SF_COMMAND_FAILED', '실패 force://client:must-not-leak@example.com');
      }
      if (this.failure === 'ambiguous') {
        throw new SfudError(
          'SF_COMMAND_TIMEOUT',
          'Salesforce 응답 대기 중 연결이 끊겼습니다. deployment 0Af000000000001AAA',
        );
      }
      return { status: 0, result: {
        id: this.failure === 'report-interrupted' ? '0Af000000000001AAA' : args.includes('--dry-run') ? '0Af-check-only' : args[2] === 'quick' ? '0Af-quick' : '0Af-deploy',
        status: 'Queued',
        done: false,
      } };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && args[2] === 'report') {
      const id = flagValue(args, '--job-id');
      if (this.failure === 'report-interrupted' && this.calls.filter(call => call.args[2] === 'report').length === 1) {
        throw new SfudError('SF_COMMAND_TIMEOUT', 'report timeout');
      }
      if (this.failure === 'reported') {
        return { status: 0, result: {
          id, status: 'Failed', done: true, success: false,
          numberComponentsDeployed: 2, numberComponentsTotal: 2, numberComponentErrors: 0,
          numberTestsCompleted: 0, numberTestsTotal: 1, numberTestErrors: 1,
          details: {
            componentFailures: [],
            runTestResult: {
              failures: [{
                name: 'CryptoUtil_Test', methodName: 'encryptsAndDecryptsWithConfiguredKey',
                message: 'System.QueryException: List has no rows for assignment to SObject',
                stackTrace: 'Class.CryptoUtil.<init>: line 22, column 1',
              }],
              codeCoverageWarnings: [{
                name: 'CryptoUtil',
                message: 'Test coverage of selected Apex Class is 8.696%, at least 75% test coverage is required',
              }],
            },
          },
        } };
      }
      return { status: 0, result: {
        id,
        ...(id === '0Af000000000001' || id === '0Af-check-only' ? { checkOnly: true } : {}),
        status: 'Succeeded',
        done: true,
        success: true,
        numberComponentsDeployed: 2,
        numberComponentsTotal: 2,
        numberTestsCompleted: 1,
        numberTestsTotal: 1,
        accessToken: 'must-not-leak',
        details: { runTestResult: { codeCoverage: [
          { name: 'Hello', numLocations: 100, numLocationsNotCovered: 100 - this.coverage },
        ] } },
      } };
    }
    throw new Error(`예상하지 못한 sf 명령: ${args.join(' ')}`);
  }
}

class GatedMetadataSfClient extends DryRunSfClient {
  private metadataCalls = 0;
  private readonly metadataBlocked: Promise<void>;
  private metadataBlockedResolve!: () => void;
  private readonly metadataGate: Promise<void>;
  private metadataGateResolve!: () => void;

  public constructor(private readonly blockAfter: number) {
    super();
    this.metadataBlocked = new Promise<void>((resolve) => { this.metadataBlockedResolve = resolve; });
    this.metadataGate = new Promise<void>((resolve) => { this.metadataGateResolve = resolve; });
  }

  public async waitForBlockedMetadata(): Promise<void> {
    await this.metadataBlocked;
  }

  public releaseMetadata(): void {
    this.metadataGateResolve();
  }

  public override async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      this.metadataCalls += 1;
      if (this.metadataCalls >= this.blockAfter) this.metadataBlockedResolve();
      await this.metadataGate;
    }
    return await super.runJson(args, options);
  }
}

class AbortableDeploymentSfClient extends DryRunSfClient {
  private readonly reportStarted: Promise<void>;
  private reportStartedResolve!: () => void;

  public constructor() {
    super();
    this.reportStarted = new Promise<void>((resolve) => {
      this.reportStartedResolve = resolve;
    });
  }

  public waitForReport(): Promise<void> {
    return this.reportStarted;
  }

  public override async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    if (args[0] === 'project' && args[1] === 'deploy' && args[2] === 'report') {
      this.reportStartedResolve();
      return await new Promise((_resolve, reject) => {
        const abort = () => reject(new SfudError(
          'SF_COMMAND_ABORTED',
          'Salesforce CLI 명령이 취소되었습니다.',
        ));
        if (options.signal?.aborted === true) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return await super.runJson(args, options);
  }
}

async function createFixture(client: DryRunSfClient, options: { quickDeployEnabled?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-dry-run-api-'));
  const projectPath = path.join(root, 'project');
  await mkdir(path.join(projectPath, 'manifest'), { recursive: true });
  await mkdir(path.join(projectPath, 'force-app'), { recursive: true });
  await writeFile(path.join(projectPath, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '67.0',
  }));
  await writeFile(path.join(projectPath, 'manifest', 'package.xml'), '<Package/>\n');
  const server = await createWebServer({
    host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
    databasePath: path.join(root, 'data', 'sfud.db'), projectPaths: [projectPath],
    bootstrapToken: 'dry-run-bootstrap-token', sfClient: client, ...options,
  });
  return {
    root,
    projectPath,
    client,
    server,
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/bootstrap',
    payload: {
      bootstrapToken: 'dry-run-bootstrap-token', email: 'admin@example.com',
      displayName: '관리자', password: 'dry run test password',
    },
  });
  return {
    cookie: (response.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; '),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function writeSnapshot(outputDirectory: string, value: string): Promise<void> {
  await writeFixtureFiles(outputDirectory, {
    'package.xml': '<Package/>\n',
    'classes/Hello.cls': `public class Hello { String value = '${value}'; }\n`,
    'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
    'classes/Hello_Test.cls': 'public class Hello_Test {}\n',
    'classes/Hello_Test.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
    'classes/HelloSpec.cls': 'public class HelloSpec {}\n',
    'classes/HelloSpec.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
  });
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`${flag} argument missing`);
  return value;
}

function deploymentStartCalls<T extends { args: readonly string[] }>(calls: readonly T[]): T[] {
  return calls.filter((call) => call.args[0] === 'project' && call.args[1] === 'deploy' && call.args[2] === 'start');
}
