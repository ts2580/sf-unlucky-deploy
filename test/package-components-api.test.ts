import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SfClient } from '../src/salesforce/sf-client.js';
import { pinSalesforceConnection, runAsSalesforceUser } from '../src/salesforce/user-context.js';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from './support/files.js';

describe('package component loading API', () => {
  it('checks access, reuses owner/version-scoped membership in comparison, and reloads upgraded packages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-api-'));
    const project = path.join(root, 'project');
    await writeFixtureFiles(project, {
      'sfdx-project.json': '{"packageDirectories":[{"path":"force-app","default":true}]}',
      'manifest/package.xml': '<Package><types><members>Owned</members><members>Keep</members><name>ApexClass</name></types><version>67.0</version></Package>',
    });
    let version = '04t000000000001';
    let retrieveCount = 0;
    let fail = false;
    const sfClient: SfClient = { async runJson(args) {
      if (args[0] === 'package') return { result: [{ SubscriberPackageId: '033000000000001', SubscriberPackageName: 'Unlocked CRM', SubscriberPackageNamespace: null, SubscriberPackageVersionId: version }] };
      if (args[0] === 'org') return { result: { nonScratchOrgs: [{ alias: 'dev', connectedStatus: 'Connected', username: 'dev@example.com' }] } };
      if (args.includes('--package-name')) {
        retrieveCount += 1;
        if (fail) throw new Error('Package permission denied');
        const output = args[args.indexOf('--target-metadata-dir') + 1]!;
        await writeFixtureFiles(path.join(output, 'Unlocked CRM'), {
          'package.xml': '<Package><types><members>Owned</members><name>ApexClass</name></types><version>67.0</version></Package>',
          'classes/Owned.cls': 'reference only',
        });
        return { result: { success: true, done: true } };
      }
      if (args[1] === 'retrieve') {
        await writeFixtureFiles(args[args.indexOf('--target-metadata-dir') + 1]!, {
          'package.xml': '<Package/>', 'classes/Owned.cls': 'owned', 'classes/Keep.cls': 'keep',
        });
        return { result: { success: true } };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    } };
    const app = await createWebServer({ host: '127.0.0.1', port: 0, sfClient, databasePath: path.join(root, 'db'), projectPaths: [project], assetsDirectory: '/missing', bootstrapToken: 'package-bootstrap' });
    try {
      const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap', payload: {
        bootstrapToken: 'package-bootstrap', email: 'package@example.com', displayName: 'Package admin', password: 'package test password',
      } });
      const cookie = (bootstrap.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      const headers = { cookie, 'x-sfud-csrf': bootstrap.json().csrfToken as string };
      const owner = bootstrap.json().user.id as string;
      const url = '/api/v1/installed-packages/033000000000001/components';
      const payload = { sourceIds: ['org:dev'] };
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, payload, headers: { cookie } })).statusCode).toBe(403);
      await app.sfudRuntime.store.database.run("UPDATE users SET role = 'VIEWER'");
      expect((await app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(403);
      await app.sfudRuntime.store.database.run("UPDATE users SET role = 'ADMIN'");
      for (const sourceIds of [[], ['org:missing'], ['project:any'], ['org:dev', 'org:dev', 'org:dev'], [null]]) {
        expect((await app.inject({ method: 'POST', url, payload: { sourceIds }, headers })).statusCode).toBe(400);
      }
      expect(retrieveCount).toBe(0);
      const loaded = await app.inject({ method: 'POST', url, payload, headers });
      expect(loaded.statusCode, loaded.body).toBe(200);
      expect(loaded.json()).toMatchObject({ package: { componentCount: 1 }, components: [{ type: 'ApexClass', fullName: 'Owned' }] });
      expect(loaded.json().package.exclusionUnavailableReason).toBeUndefined();
      expect((await app.inject({ url: '/api/v1/installed-packages?sourceIds=org:dev', headers })).json().packages[0]).toMatchObject({ componentCount: 1 });
      const workspace = (await app.inject({ url: '/api/v1/workspace', headers })).json();
      const comparison = await app.inject({ method: 'POST', url: '/api/v1/comparisons', headers, payload: {
        projectId: workspace.projects[0].id, manifest: 'manifest/package.xml', leftSourceId: 'org:dev', rightSourceId: 'org:dev', sourceOnly: true,
        excludedPackageIds: ['033000000000001'],
      } });
      expect(comparison.statusCode, comparison.body).toBe(202);
      await app.sfudRuntime.comparisonQueue.onIdle();
      const job = await app.sfudRuntime.comparisonJobs.getRequired(comparison.json().job.id as string);
      expect(job.status, job.errorMessage).toBe('SUCCEEDED');
      expect(job.result?.components.map((member) => member.fullName)).toEqual(['Keep']);
      expect(job.result?.packageExclusion).toMatchObject({ namespaces: [], unnamespacedPackages: [], excludedComponents: 1 });
      expect(retrieveCount).toBe(1);
      await runAsSalesforceUser('different-owner', () => app.sfudRuntime.workspace.loadPackageComponents(['org:dev'], '033000000000001', 'different-owner'));
      expect(retrieveCount).toBe(2);
      for (const generation of [1, 1, 2]) {
        await runAsSalesforceUser(owner, () => {
          pinSalesforceConnection('dev', 'test-connection', generation);
          return app.sfudRuntime.workspace.loadPackageComponents(['org:dev'], '033000000000001', owner);
        });
        expect(retrieveCount).toBe(generation === 1 ? 3 : 4);
      }
      version = '04t000000000002';
      expect((await app.inject({ url: '/api/v1/installed-packages?sourceIds=org:dev', headers })).json().packages[0].componentCount).toBeUndefined();
      fail = true;
      const failed = await app.inject({ method: 'POST', url, payload, headers });
      expect(failed.statusCode).toBe(400);
      expect(failed.json().error.message).toContain('permission denied');
      fail = false;
      expect((await app.inject({ method: 'POST', url, payload, headers })).statusCode).toBe(200);
      expect(retrieveCount).toBe(6);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
