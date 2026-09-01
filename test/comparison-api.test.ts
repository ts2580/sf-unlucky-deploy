import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from './support/files.js';

describe('비교 API', () => {
  it('허용된 workspace만 노출하고 비동기 비교 결과를 영속화한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-comparison-api-'));
    const projectPath = path.join(root, 'project');
    const manifestDirectory = path.join(projectPath, 'manifest');
    const classesDirectory = path.join(projectPath, 'force-app', 'main', 'default', 'classes');
    await mkdir(manifestDirectory, { recursive: true });
    await mkdir(classesDirectory, { recursive: true });
    await writeFile(path.join(projectPath, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: '64.0',
    }));
    await writeFile(path.join(manifestDirectory, 'package.xml'), '<Package/>\n');
    await writeFile(path.join(classesDirectory, 'Local_Test.cls'), '@IsTest private class Local_Test {}\n');
    await writeFile(path.join(classesDirectory, 'LocalSpec.cls'), '@IsTest private class LocalSpec {}\n');
    await writeFile(path.join(classesDirectory, 'Helper.cls'), 'public class Helper {}\n');
    const sfClient = new ComparisonSfClient();
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: path.join(root, 'data', 'sfud.db'),
      projectPaths: [projectPath],
      bootstrapToken: 'comparison-bootstrap-token',
      sfClient,
    });

    try {
      const bootstrap = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/bootstrap',
        payload: {
          bootstrapToken: 'comparison-bootstrap-token',
          email: 'operator@example.com',
          displayName: '비교 관리자',
          password: 'comparison test password',
        },
      });
      const cookie = (bootstrap.headers['set-cookie'] as string[])
        .map((value) => value.split(';')[0]).join('; ');
      const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;

      const workspace = await server.inject({ url: '/api/v1/workspace', headers: { cookie } });
      expect(workspace.statusCode).toBe(200);
      expect(workspace.json()).toMatchObject({
        orgs: [
          { alias: 'left', connected: true },
          { alias: 'right', connected: true },
        ],
        projects: [{ displayName: 'project', manifests: ['manifest/package.xml'] }],
      });
      expect(workspace.body).not.toContain('access-token-secret');
      expect(workspace.body).not.toContain(projectPath);
      const projectId = workspace.json<{ projects: Array<{ id: string }> }>().projects[0]!.id;
      const metadataTypes = await server.inject({
        url: '/api/v1/metadata-types?sourceIds=org%3Aleft%2Corg%3Aright',
        headers: { cookie },
      });
      expect(metadataTypes.statusCode).toBe(200);
      expect(metadataTypes.json()).toEqual({
        metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }],
      });
      const metadataTypeCalls = sfClient.calls.filter((args) =>
        args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types');
      expect(metadataTypeCalls).toHaveLength(2);
      for (const args of metadataTypeCalls) {
        expect(args).toEqual(expect.arrayContaining(['--api-version', '64.0']));
      }
      const orgTests = await server.inject({
        url: '/api/v1/apex-test-classes?sourceId=org%3Aleft', headers: { cookie },
      });
      expect(orgTests.statusCode).toBe(200);
      expect(orgTests.json()).toEqual({ testClasses: ['Account_Test', 'Order_test'] });
      expect(sfClient.calls).toContainEqual(expect.arrayContaining([
        'data', 'query', '--use-tooling-api', '--target-org', 'left', '--api-version', '64.0',
      ]));
      const localTests = await server.inject({
        url: `/api/v1/apex-test-classes?sourceId=project%3A${projectId}`, headers: { cookie },
      });
      expect(localTests.statusCode).toBe(200);
      expect(localTests.json()).toEqual({ testClasses: ['Local_Test'] });
      expect((await server.inject({
        method: 'PUT', url: '/api/v1/settings',
        headers: { cookie, 'x-sfud-csrf': csrfToken },
        payload: { testClassSuffix: 'Spec' },
      })).statusCode).toBe(200);
      expect((await server.inject({
        url: '/api/v1/apex-test-classes?sourceId=org%3Aleft', headers: { cookie },
      })).json()).toEqual({ testClasses: ['AccountSpec'] });
      expect((await server.inject({
        url: `/api/v1/apex-test-classes?sourceId=project%3A${projectId}`, headers: { cookie },
      })).json()).toEqual({ testClasses: ['LocalSpec'] });
      const comparisonPayload = {
        projectId,
        manifest: 'manifest/package.xml',
        leftSourceId: 'org:left',
        rightSourceId: 'org:right',
        strict: false,
        showIdentical: false,
      };

      expect((await server.inject({
        method: 'POST', url: '/api/v1/comparisons', headers: { cookie }, payload: comparisonPayload,
      })).statusCode).toBe(403);
      await server.sfudRuntime.store.database.run("UPDATE users SET role = 'VIEWER'");
      expect((await server.inject({
        method: 'POST', url: '/api/v1/comparisons', headers: { cookie, 'x-sfud-csrf': csrfToken }, payload: comparisonPayload,
      })).statusCode).toBe(403);
      await server.sfudRuntime.store.database.run("UPDATE users SET role = 'ADMIN'");

      const created = await server.inject({
        method: 'POST',
        url: '/api/v1/comparisons',
        headers: { cookie, 'x-sfud-csrf': csrfToken },
        payload: comparisonPayload,
      });
      expect(created.statusCode).toBe(202);
      const jobId = created.json<{ job: { id: string } }>().job.id;
      await server.sfudRuntime.comparisonQueue.onIdle();

      const completed = await server.inject({
        url: `/api/v1/comparisons/${jobId}`,
        headers: { cookie },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        job: {
          status: 'SUCCEEDED',
          manifest: 'manifest/package.xml',
          left: { id: 'org:left', label: 'left' },
          right: { id: 'org:right', label: 'right' },
          result: { summary: { modified: 1, different: 1 } },
        },
      });
      expect(completed.body).not.toContain(projectPath);
      expect(await server.sfudRuntime.store.database.get(
        "SELECT COUNT(*) count FROM audit_events WHERE event_type = 'COMPARISON_SUCCEEDED'",
      )).toEqual({ count: 1 });

      const unbounded = await server.inject({
        method: 'POST', url: '/api/v1/comparisons',
        headers: { cookie, 'x-sfud-csrf': csrfToken },
        payload: { scope: 'all', leftSourceId: 'org:left', rightSourceId: 'org:right' },
      });
      expect(unbounded.statusCode).toBe(400);
      expect(unbounded.json()).toMatchObject({ error: {
        message: expect.stringContaining('전체 메타데이터 검색은 지원하지 않습니다'),
      } });

      const allCreated = await server.inject({
        method: 'POST',
        url: '/api/v1/comparisons',
        headers: { cookie, 'x-sfud-csrf': csrfToken },
        payload: {
          scope: 'all',
          metadataType: 'ApexClass',
          leftSourceId: 'org:left',
          rightSourceId: 'org:right',
        },
      });
      expect(allCreated.statusCode).toBe(202);
      const allJobId = allCreated.json<{ job: { id: string } }>().job.id;
      await server.sfudRuntime.comparisonQueue.onIdle();
      const allCompleted = await server.inject({
        url: `/api/v1/comparisons/${allJobId}`,
        headers: { cookie },
      });
      expect(allCompleted.json()).toMatchObject({
        job: {
          status: 'SUCCEEDED',
          scope: 'all',
          metadataType: 'ApexClass',
          manifest: 'ApexClass',
        },
      });
      expect(sfClient.calls.filter((args) =>
        args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest'))
        .toHaveLength(2);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('인증, CSRF와 역할이 없으면 비교 실행을 거부한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 27_546,
      assetsDirectory: '/definitely/missing/sfud-ui',
      databasePath: ':memory:',
    });
    try {
      expect((await server.inject({ method: 'POST', url: '/api/v1/comparisons', payload: {} })).statusCode)
        .toBe(401);
      expect((await server.inject({ url: '/api/v1/apex-test-classes?sourceId=org%3Aleft' })).statusCode)
        .toBe(401);
    } finally {
      await server.close();
    }
  });
});

class ComparisonSfClient implements SfClient {
  public readonly calls: string[][] = [];

  public async runJson(args: readonly string[], _options: SfRunOptions): Promise<unknown> {
    this.calls.push([...args]);
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { status: 0, result: { metadataObjects: [
        { directoryName: 'classes', suffix: 'cls', xmlName: 'ApexClass' },
      ] } };
    }
    if (args[0] === 'org' && args[1] === 'list') {
      return {
        status: 0,
        result: {
          nonScratchOrgs: [
            { alias: 'left', name: 'Left Org', orgEdition: 'Developer', connectedStatus: 'Connected', accessToken: 'access-token-secret' },
            { alias: 'right', name: 'Right Org', orgEdition: 'Sandbox', connectedStatus: 'Connected' },
          ],
        },
      };
    }
    if (args[0] === 'data' && args[1] === 'query') {
      return { status: 0, result: { records: [
        { Name: 'Account_Test' },
        { Name: 'AccountSpec' },
        { Name: 'Helper' },
        { Name: 'Order_test' },
      ] } };
    }
    if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
      const outputDirectory = flagValue(args, '--output-dir');
      const name = flagValue(args, '--name');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, name), `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types><members>Hello</members><name>ApexClass</name></types>
  <version>67.0</version>
</Package>
`);
      return { status: 0 };
    }
    const alias = flagValue(args, '--target-org');
    const outputDirectory = flagValue(args, '--target-metadata-dir');
    await writeFixtureFiles(outputDirectory, {
      'package.xml': '<Package/>\n',
      'classes/Hello.cls': `public class Hello { String value() { return '${alias}'; } }\n`,
      'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
    });
    return { status: 0 };
  }
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`${flag} argument missing`);
  return value;
}
