import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';
import { GitImportService } from '../src/git/git-import-service.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import type { GitProvider } from '../src/git/git-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { writeFixtureFiles } from './support/files.js';

const sha = '1'.repeat(40);
const manifest = '<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>Hello</members><name>ApexClass</name></types><version>61.0</version></Package>';
const request = {
  provider: 'github' as const,
  repositoryPath: 'sample/project',
  ref: { kind: 'branch' as const, name: 'main' },
  expectedCommitSha: sha,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function objects(): GitObjectReader {
  const files = new Map<string, Buffer>([
    ['sfdx-project.json', Buffer.from('{"packageDirectories":[{"path":"force-app"}],"sourceApiVersion":"61.0"}')],
    ['force-app/main/default/classes/Hello.cls', Buffer.from('public class Hello {}')],
    ['force-app/main/default/classes/Hello.cls-meta.xml', Buffer.from('<ApexClass><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>')],
    ['manifest/package.xml', Buffer.from(manifest)],
  ]);
  return {
    async listTree() {
      return [...files].map(([file, content]) => ({ path: file, objectId: file, mode: '100644', type: 'blob' as const, size: content.length }));
    },
    async readBlob(id) { return files.get(id)!; },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-sharing-'));
  const server = await createWebServer({
    host: '127.0.0.1', port: 0, assetsDirectory: '/missing',
    databasePath: path.join(root, 'sfud.db'), bootstrapToken: 'git-sharing-bootstrap',
    sfClient: {
      async runJson(args) {
        if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
          return { result: { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes' }] } };
        }
        if (args[0] === 'org' && args[1] === 'list') {
          return { result: { nonScratchOrgs: [{ alias: 'target', username: 'target@example.com', orgId: '00D000000000001', connectedStatus: 'Connected' }] } };
        }
        const flag = (name: string) => args[args.indexOf(name) + 1]!;
        if (args.includes('convert') || args.includes('retrieve')) {
          await writeFixtureFiles(flag(args.includes('convert') ? '--output-dir' : '--target-metadata-dir'), {
            'package.xml': manifest,
            'classes/Hello.cls': `public class Hello { String value = '${args.includes('convert') ? 'source' : 'target'}'; }`,
            'classes/Hello.cls-meta.xml': '<ApexClass></ApexClass>',
          });
          return { status: 0 };
        }
        if (args[1] === 'deploy' && args[2] === 'start') return { result: { id: '0Af-git-sharing', status: 'Queued', done: false } };
        if (args[1] === 'deploy' && args[2] === 'report') return { result: { id: '0Af-git-sharing', status: 'Succeeded', done: true, success: true } };
        throw new Error('Test SF execution intentionally blocked');
      },
    },
  });
  const owner = await server.sfudRuntime.auth.bootstrapAdmin({
    bootstrapToken: 'git-sharing-bootstrap', email: 'owner@example.com', displayName: 'Owner', password: 'git sharing test password',
  });
  const recipientUser = await server.sfudRuntime.auth.createManagedUser({
    actorUserId: owner.user.id, email: 'recipient@example.com', displayName: 'Recipient', role: 'DEPLOYER', password: 'git sharing test password',
  });
  const recipient = await server.sfudRuntime.auth.login(recipientUser.email, 'git sharing test password');
  const headers = (session: typeof owner) => ({ cookie: `sfud_session=${session.sessionToken}`, 'x-sfud-csrf': session.csrfToken });
  const provider: GitProvider = {
    id: 'github',
    // The provider is deliberately fake; this test exercises source ACL propagation,
    // while private-provider OAuth authorization is covered by the route suite.
    inspect: vi.fn(async () => ({ ...normalizeRepository(request.repositoryPath, 'github'), repositoryId: '123', private: false, defaultBranch: 'main' })),
    resolveCommit: vi.fn(async () => sha),
    listRefs: vi.fn(async () => ({ refs: [{ ...request.ref, commitSha: sha }] })),
  };
  const fetch = vi.fn(async (input: GitFetchOptions) => { input.onDiskUsage(100); return objects(); });
  const imports = new GitImportService(
    new GitImportRepository(server.sfudRuntime.store.database),
    server.sfudRuntime.workspace.managedProjects,
    { providers: { github: provider, gitlab: provider, bitbucket: provider }, client: { fetch } },
  );
  server.sfudRuntime.gitImports = imports;
  server.sfudRuntime.workspace.gitImports = imports;
  cleanups.push(async () => {
    await imports.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { server, imports, owner, recipient, headers, recipientUser, request };
}

describe('Git 가져오기 소스 공유와 파생 작업 ACL', { timeout: 60_000 }, () => {
  it('git provenance를 유지한 채 comparison/dry-run을 읽기 공유하고 EXECUTE 승인까지 허용한 뒤 철회한다', async () => {
    const { server, imports, owner, recipient, headers, recipientUser, request: importRequest } = await fixture();
    const imported = await imports.create(owner.user.id, importRequest);
    await vi.waitFor(async () => expect((await imports.get(imported.id, owner.user.id)).status).toBe('READY'));
    const sourceId = `git:${imported.id}`;
    const comparison = await server.sfudRuntime.comparisons.create({
      projectId: sourceId, manifest: 'manifest/package.xml', leftSourceId: 'org:target', rightSourceId: sourceId,
      strict: false, showIdentical: false, createdBy: owner.user.id,
    });
    await server.sfudRuntime.comparisonQueue.onIdle();
    const comparisonJob = await server.sfudRuntime.comparisonJobs.getRequired(comparison.id);
    expect(comparisonJob.status).toBe('SUCCEEDED');
    expect(comparisonJob.sourceSnapshot?.right?.provenance?.repositoryPath).toBe(importRequest.repositoryPath);

    const dryRun = await server.sfudRuntime.dryRuns.create({
      projectId: sourceId, manifest: 'manifest/package.xml', sourceId, targetOrgId: 'org:target',
      testLevel: 'NoTestRun', tests: [], testClassSuffix: '_Test', waitMinutes: 1,
      strict: false, createdBy: owner.user.id, clientRequestId: `git-sharing-${imported.id}`,
    });
    await server.sfudRuntime.deploymentQueue.onIdle();
    await server.sfudRuntime.deploymentCoordinator.flushCompletions();
    const prepared = await server.sfudRuntime.deploymentJobs.getRequired(dryRun.id);
    expect(prepared.status, prepared.errorMessage ?? prepared.errorCode).toBe('APPROVAL_PENDING');
    expect(prepared.sourceSnapshot?.source?.provenance?.repositoryPath).toBe(importRequest.repositoryPath);

    const recipientHeaders = headers(recipient);
    expect((await server.inject({ url: `/api/v1/comparisons/${comparison.id}`, headers: recipientHeaders })).statusCode).toBe(404);
    expect((await server.inject({ url: `/api/v1/deployment-jobs/${dryRun.id}`, headers: recipientHeaders })).statusCode).toBe(404);

    const grantComparison = `/api/v1/job-access/comparison/${comparison.id}/${recipientUser.id}`;
    const grantDeployment = `/api/v1/job-access/deployment/${dryRun.id}/${recipientUser.id}`;
    expect((await server.inject({ method: 'PUT', url: grantComparison, headers: headers(owner), payload: { permission: 'READ' } })).statusCode).toBe(204);
    expect((await server.inject({ url: `/api/v1/comparisons/${comparison.id}`, headers: recipientHeaders })).statusCode).toBe(200);
    const sharedComparison = (await server.inject({ url: `/api/v1/comparisons/${comparison.id}`, headers: recipientHeaders })).json();
    expect(sharedComparison.job.right.provenance.repositoryPath).toBe(importRequest.repositoryPath);

    expect((await server.inject({ method: 'PUT', url: grantDeployment, headers: headers(owner), payload: { permission: 'READ' } })).statusCode).toBe(204);
    expect((await server.inject({ url: `/api/v1/deployment-jobs/${dryRun.id}`, headers: recipientHeaders })).statusCode).toBe(200);
    await expect(server.sfudRuntime.deploymentJobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id, payloadChecksum: prepared.payloadChecksum, targetAlias: prepared.targetAlias,
      confirmation: '실제 배포', approvedBy: recipient.user.id,
    })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect((await server.inject({ method: 'PUT', url: grantDeployment, headers: headers(owner), payload: { permission: 'EXECUTE' } })).statusCode).toBe(204);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', dryRun.id, recipient.user.id, 'EXECUTE')).toBe(true);
    const deployment = await server.sfudRuntime.deploymentJobs.approveAndQueueDeployment({
      dryRunJobId: dryRun.id, payloadChecksum: prepared.payloadChecksum, targetAlias: prepared.targetAlias,
      confirmation: '실제 배포', approvedBy: recipient.user.id,
    });
    expect(deployment.sourceSnapshot?.source?.provenance?.repositoryPath).toBe(importRequest.repositoryPath);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', deployment.id, recipient.user.id, 'EXECUTE')).toBe(true);

    expect((await server.inject({ method: 'DELETE', url: grantComparison, headers: headers(owner) })).statusCode).toBe(204);
    expect((await server.inject({ url: `/api/v1/comparisons/${comparison.id}`, headers: recipientHeaders })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: grantDeployment, headers: headers(owner) })).statusCode).toBe(204);
    expect((await server.inject({ url: `/api/v1/deployment-jobs/${dryRun.id}`, headers: recipientHeaders })).statusCode).toBe(404);
    const grantApprovedDeployment = `/api/v1/job-access/deployment/${deployment.id}/${recipientUser.id}`;
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', deployment.id, recipient.user.id, 'EXECUTE')).toBe(true);
    expect((await server.inject({ method: 'DELETE', url: grantApprovedDeployment, headers: headers(owner) })).statusCode).toBe(204);
    expect(await server.sfudRuntime.jobAccess.canAccess('deployment', deployment.id, recipient.user.id, 'EXECUTE')).toBe(false);
  });
});
