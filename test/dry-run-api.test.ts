import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SfudError } from '../src/core/errors.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from './support/files.js';

describe('dry-run API', () => {
  it('허용된 source를 check-only로 검증하고 payload와 테스트 결과를 영속화한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
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
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
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
          testPlan: { level: 'RunSpecifiedTests', tests: ['Hello_Test'], selection: 'suffix' },
          comparisonSummary: { modified: 1 },
        },
      });
      expect(response.body).not.toContain('must-not-leak');
      expect(response.body).not.toContain(fixture.projectPath);
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(1);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      expect(deployCalls[0]!.args).toEqual(expect.arrayContaining([
        '--test-level', 'RunSpecifiedTests', '--tests', 'Hello_Test', '--async',
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
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
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

  it('선택한 배포 대상 metadata만 dry-run하고 승인된 동일 payload를 실제 배포한다', async () => {
    const fixture = await createFixture(new DryRunSfClient());
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ sources: Array<{ id: string; kind: string }> }>();
      const sourceId = workspace.sources.find((source) => source.kind === 'local')!.id;
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
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
      expect(dryRun).toMatchObject({ status: 'APPROVAL_PENDING', prepared: true });
      expect(await readFile(dryRun.manifestPath, 'utf8')).toContain('<members>Hello</members>');
      expect(await readFile(dryRun.manifestPath, 'utf8')).not.toContain('<members>Hello_Test</members>');

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
        testPlan: { level: 'RunLocalTests' },
      } });
      const deploymentId = approved.json<{ job: { id: string } }>().job.id;
      await fixture.server.sfudRuntime.deploymentQueue.onIdle();
      expect(await fixture.server.sfudRuntime.deploymentJobs.getRequired(deploymentId)).toMatchObject({
        kind: 'DEPLOY', status: 'SUCCEEDED', prepared: true,
        testPlan: { level: 'RunLocalTests' },
        selectedComponents: [{ type: 'ApexClass', fullName: 'Hello' }],
      });
      const deployCalls = deploymentStartCalls(fixture.client.calls);
      expect(deployCalls).toHaveLength(2);
      expect(deployCalls[0]!.args).toContain('--dry-run');
      expect(deployCalls[1]!.args).not.toContain('--dry-run');
      expect(deployCalls[1]!.args).toEqual(expect.arrayContaining([
        '--target-org', 'target', '--test-level', 'RunLocalTests',
      ]));
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
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', tests: [], targetConfirmation: 'target',
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
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', tests: ['CoverageSpec'],
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
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          scope: 'selected', components: [{ type: 'ApexClass', fullName: 'Hello' }],
          sourceId, targetOrgId: 'org:target', tests: ['CoverageSpec'],
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

  it('Salesforce 실패를 민감 정보 없이 FAILED로 기록한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('definitive'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const created = await fixture.server.inject({
        method: 'POST',
        url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
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
      expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'JOB_EXECUTION_FAILED' });
      expect(failed.errorMessage).not.toContain('force://client:must-not-leak');
      expect(failed.errorMessage).toContain('force://[REDACTED]');
    } finally {
      await fixture.close();
    }
  });

  it('제출 후 Salesforce 응답이 끊기면 RECONCILE_REQUIRED로 기록한다', async () => {
    const fixture = await createFixture(new DryRunSfClient('ambiguous'));
    try {
      const auth = await bootstrap(fixture.server);
      const workspace = (await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json<{ projects: Array<{ id: string }>; sources: Array<{ id: string; kind: string }> }>();
      const created = await fixture.server.inject({
        method: 'POST', url: '/api/v1/deployments/dry-run',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
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
        errorCode: 'EXTERNAL_STATE_UNKNOWN',
        salesforceDeploymentId: '0Af000000000001AAA',
      });
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
});

class DryRunSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];

  public constructor(
    private readonly failure: 'none' | 'definitive' | 'ambiguous' = 'none',
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
      return { status: 0, result: { nonScratchOrgs: [
        { alias: 'target', name: 'Target', orgEdition: 'Developer', connectedStatus: 'Connected' },
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
    if (args[0] === 'project' && args[1] === 'deploy' && args[2] === 'start') {
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
        id: args.includes('--dry-run') ? '0Af-check-only' : '0Af-deploy',
        status: 'Queued',
        done: false,
      } };
    }
    if (args[0] === 'project' && args[1] === 'deploy' && args[2] === 'report') {
      const id = flagValue(args, '--job-id');
      return { status: 0, result: {
        id,
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

async function createFixture(client: DryRunSfClient) {
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
    bootstrapToken: 'dry-run-bootstrap-token', sfClient: client,
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
