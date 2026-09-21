import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { GitImportRepository, type GitImportRecord } from '../src/storage/git-import-repository.js';
import { GitImportService } from '../src/git/git-import-service.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import type { GitProvider } from '../src/git/git-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GitError } from '../src/git/git-errors.js';
import { writeFixtureFiles } from './support/files.js';
import { sha256DirectoryV2 } from '../src/core/files.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha = '1'.repeat(40);
const request = { provider: 'github' as const, repositoryPath: 'sample/project', ref: { kind: 'branch' as const, name: 'main' }, expectedCommitSha: sha };
const manifest = '<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>Hello</members><name>ApexClass</name></types><version>61.0</version></Package>';

function objects(roots = ['.']): GitObjectReader {
  const files = new Map<string, Buffer>();
  for (const root of roots) for (const [file, text] of Object.entries({
    'sfdx-project.json': '{"packageDirectories":[{"path":"force-app"}],"sourceApiVersion":"61.0"}',
    'force-app/main/default/classes/Hello.cls': 'public class Hello {}',
    'force-app/main/default/classes/Hello.cls-meta.xml': '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>',
    'manifest/package.xml': manifest,
  })) files.set(root === '.' ? file : `${root}/${file}`, Buffer.from(text));
  return {
    async listTree() { return [...files].map(([file, content]) => ({ path: file, objectId: file, mode: '100644', type: 'blob', size: content.length })); },
    async readBlob(id) { return files.get(id)!; },
  };
}

async function fixture(options: { roots?: string[]; timeoutMs?: number; quota?: number; executeSf?: boolean;
  fetch?: (options: GitFetchOptions) => Promise<GitObjectReader> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-import-service-'));
  const server = await createWebServer({ host: '127.0.0.1', port: 0, assetsDirectory: '/missing',
    databasePath: path.join(root, 'sfud.db'), bootstrapToken: 'git-import-bootstrap',
    ...(options.quota === undefined ? {} : { userImportQuotaBytes: options.quota }),
    sfClient: { async runJson(args) {
      if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
        return { result: { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes' }] } };
      }
      if (args[0] === 'org' && args[1] === 'list') return { result: { nonScratchOrgs: [
        { alias: 'target', username: 'target@example.com', orgId: '00D000000000001', connectedStatus: 'Connected' },
      ] } };
      if (options.executeSf) {
        const flag = (name: string) => args[args.indexOf(name) + 1]!;
        if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
          await writeFile(path.join(flag('--output-dir'), flag('--name')), manifest, 'utf8');
          return { status: 0 };
        }
        if (args.includes('convert') || args.includes('retrieve')) {
          await writeFixtureFiles(flag(args.includes('convert') ? '--output-dir' : '--target-metadata-dir'), {
            'package.xml': manifest,
            'classes/Hello.cls': `public class Hello { String value = '${args.includes('convert') ? 'source' : 'target'}'; }`,
            'classes/Hello.cls-meta.xml': '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>',
          });
          return { status: 0 };
        }
        if (args[1] === 'deploy' && args[2] === 'start') return { result: { id: '0Af-git-fixture', status: 'Queued', done: false } };
        if (args[1] === 'deploy' && args[2] === 'report') return { result: { id: '0Af-git-fixture', status: 'Succeeded', done: true, success: true } };
      }
      throw new Error('Test SF execution intentionally blocked');
    } },
  });
  const owner = await server.sfudRuntime.auth.bootstrapAdmin({ bootstrapToken: 'git-import-bootstrap',
    email: 'owner@example.com', displayName: 'owner', password: 'git import test password' });
  const other = await server.sfudRuntime.auth.createManagedUser({ actorUserId: owner.user.id,
    email: 'other@example.com', displayName: 'other', role: 'ADMIN', password: 'git import test password' });
  const session = await server.sfudRuntime.auth.login(other.email, 'git import test password');
  const headers = { cookie: `sfud_session=${owner.sessionToken}`, 'x-sfud-csrf': owner.csrfToken };
  const otherHeaders = { cookie: `sfud_session=${session.sessionToken}`, 'x-sfud-csrf': session.csrfToken };
  const provider: GitProvider = { id: 'github',
    inspect: vi.fn(async () => ({ ...normalizeRepository(request.repositoryPath, 'github'), repositoryId: '123', private: false, defaultBranch: 'main' })),
    resolveCommit: vi.fn(async () => sha), listRefs: vi.fn(async () => ({ refs: [{ ...request.ref, commitSha: sha }] })),
  };
  const fetch = vi.fn(options.fetch ?? (async (input: GitFetchOptions) => { input.onDiskUsage(100); return objects(options.roots); }));
  const history = new GitImportRepository(server.sfudRuntime.store.database);
  const service = new GitImportService(history, server.sfudRuntime.workspace.managedProjects, {
    providers: { github: provider, gitlab: provider, bitbucket: provider }, client: { fetch },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  server.sfudRuntime.gitImports = service;
  server.sfudRuntime.workspace.gitImports = service;
  cleanups.push(async () => { await service.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const ready = async (id: string, status: GitImportRecord['status'] = 'READY') => {
    await vi.waitFor(async () => { expect((await service.get(id, owner.user.id)).status).toBe(status); });
    return service.get(id, owner.user.id);
  };
  return { root, server, service, history, owner: owner.user.id, other: other.id, headers, otherHeaders, provider, fetch, ready };
}

describe('Git 가져오기 수명주기와 작업 연결', { timeout: 30_000 }, () => {
  it('202 API, 사용자 격리, manifest/type/Apex, 작업 pin과 삭제 뒤 immutable 출처를 연결한다', async () => {
    const f = await fixture();
    expect((await f.server.inject({ method: 'POST', url: '/api/v1/git/imports', payload: request })).statusCode).toBe(401);
    const response = await f.server.inject({ method: 'POST', url: '/api/v1/git/imports', headers: f.headers, payload: request });
    expect(response.statusCode, response.body).toBe(202);
    const id = response.json<{ import: { id: string } }>().import.id;
    const record = await f.ready(id);
    expect(record.provenance).toMatchObject({ commitSha: sha, repositoryId: '123', projectRoot: '.', importId: id, sourceOwnerUserId: f.owner });
    const workspace = f.server.sfudRuntime.workspace;
    const sourceId = `git:${id}`;
    const local = await workspace.resolveSource(sourceId, f.owner);
    await expect(workspace.resolveSource(sourceId, f.other)).rejects.toThrow();
    await expect(workspace.resolveSource(`upload:${id}`, f.owner)).rejects.toThrow();
    const selected = await workspace.resolveManifest(sourceId, 'manifest/package.xml', f.owner);
    expect(await readFile(selected.path, 'utf8')).toBe(manifest);
    await expect(workspace.resolveManifest(sourceId, 'manifest/package.xml', f.other)).rejects.toThrow();
    expect(await workspace.listMetadataTypes([sourceId], f.owner)).toContainEqual(expect.objectContaining({ name: 'ApexClass' }));
    expect(await workspace.listApexTestClasses(sourceId, f.owner)).toEqual(['Hello']);
    for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['POST', '/cancel'], ['POST', '/select-project']] as const) {
      const result = await f.server.inject({ method, url: `/api/v1/git/imports/${id}${suffix}`, headers: f.otherHeaders,
        ...(suffix === '/select-project' ? { payload: { projectRoot: '.' } } : {}) });
      expect(result.statusCode, result.body).toBe(404);
    }
    const publicWorkspace = await f.server.inject({ url: '/api/v1/workspace', headers: f.headers });
    expect(publicWorkspace.body).not.toContain(local.slice(6));
    expect(publicWorkspace.json()).toMatchObject({ projects: [{ id: sourceId, manifests: ['manifest/package.xml'] }] });
    expect(publicWorkspace.json()).not.toHaveProperty('uploads');
    expect((await f.server.inject({ url: '/api/v1/workspace', headers: f.otherHeaders })).body).not.toContain(id);
    let unblock!: () => void;
    const gate = f.server.sfudRuntime.comparisonQueue.enqueue('gate', () => new Promise<void>((resolve) => { unblock = resolve; }));
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
    try {
      const job = await f.server.sfudRuntime.comparisons.create({ projectId: sourceId, manifest: 'manifest/package.xml',
        leftSourceId: 'org:target', rightSourceId: sourceId, strict: false, showIdentical: false, createdBy: f.owner });
      await expect(f.service.remove(id, f.owner)).rejects.toThrow('사용 중');
      expect(job.sourceSnapshot?.right?.provenance).toEqual(record.provenance);
      expect(await f.server.sfudRuntime.jobAccess.canAccess('comparison', job.id, f.other)).toBe(false);
      unblock(); await gate; await f.server.sfudRuntime.comparisonQueue.onIdle();
      await f.service.remove(id, f.owner);
      await expect(access(local.slice(6))).rejects.toThrow();
      const detail = await f.server.inject({ url: `/api/v1/comparisons/${job.id}`, headers: f.headers });
      expect(detail.json()).toMatchObject({ job: { right: { id: sourceId, provenance: record.provenance }, manifest: 'manifest/package.xml' } });
      expect((await f.history.get(id, f.owner)).provenance).toEqual(record.provenance);
    } finally { unblock(); await gate; }
  });

  it('여러 DX 루트의 선택을 제한하고 중복 선택과 타 사용자 선택을 거절한다', async () => {
    const f = await fixture({ roots: ['one', 'two'] });
    const job = await f.service.create(f.owner, request);
    expect((await f.ready(job.id, 'SELECTING')).projectRoots).toEqual(['one', 'two']);
    await expect(f.service.select(job.id, f.other, 'one')).rejects.toThrow();
    await expect(f.service.select(job.id, f.owner, '../')).rejects.toThrow();
    const first = f.service.select(job.id, f.owner, 'two');
    await expect(f.service.select(job.id, f.owner, 'one')).rejects.toThrow();
    await first;
    expect((await f.ready(job.id)).provenance?.projectRoot).toBe('two');
    const retry = await f.service.create(f.owner, { ...request, projectRoot: 'one' });
    expect(retry.id).not.toBe(job.id);
    expect((await f.ready(retry.id)).provenance?.projectRoot).toBe('one');
    expect((await f.history.get(job.id, f.owner)).provenance?.projectRoot).toBe('two');
  });

  it('branch 이동은 fetch 전에 거절하고 pack/추출 quota 초과는 파일과 예약을 정리한다', async () => {
    const f = await fixture();
    vi.mocked(f.provider.resolveCommit).mockResolvedValueOnce('2'.repeat(40));
    const changed = await f.service.create(f.owner, request);
    expect((await f.ready(changed.id, 'FAILED')).errorCode).toBe('REF_CHANGED');
    expect(f.fetch).not.toHaveBeenCalled();
    const limited = await fixture({ quota: 200 });
    const job = await limited.service.create(limited.owner, request);
    expect((await limited.ready(job.id, 'FAILED')).errorCode).toBe('GIT_QUOTA_EXCEEDED');
    await vi.waitFor(() => expect(limited.server.sfudRuntime.workspace.managedProjects.list()).toEqual([]));
    // A second attempt reaches the same file quota, not a leaked admission slot.
    const retry = await limited.service.create(limited.owner, request);
    expect((await limited.ready(retry.id, 'FAILED')).errorCode).toBe('GIT_QUOTA_EXCEEDED');
  });

  it('수신 중 취소/타임아웃과 queued 취소가 소스를 뒤늦게 게시하지 못한다', async () => {
    const fetch = vi.fn(async (input: GitFetchOptions): Promise<GitObjectReader> => {
      input.onDiskUsage(50);
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve(); else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return objects(); // Even a transport ignoring cancellation cannot publish.
    });
    const f = await fixture({ fetch });
    const jobs = await Promise.all(Array.from({ length: 3 }, () => f.service.create(f.owner, request)));
    await expect(f.service.create(f.owner, request)).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    let records!: GitImportRecord[];
    await vi.waitFor(async () => {
      records = await Promise.all(jobs.map((job) => f.history.get(job.id, f.owner)));
      expect(records.filter((record) => record.status === 'QUEUED')).toHaveLength(1);
    });
    const queued = records.find((record) => record.status === 'QUEUED');
    expect(queued).toBeDefined();
    await f.service.cancel(queued!.id, f.owner);
    await Promise.all(records.filter((record) => record.id !== queued!.id).map((record) => f.service.cancel(record.id, f.owner)));
    for (const job of jobs) expect((await f.history.get(job.id, f.owner)).status).toBe('CANCELLED');
    expect(f.service.listSources(f.owner)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const timed = await fixture({ fetch, timeoutMs: 50 });
    const job = await timed.service.create(timed.owner, request);
    expect((await timed.ready(job.id, 'FAILED')).errorCode).toBe('IMPORT_TIMEOUT');
  });

  it('재시작 복구는 출처 이력을 보존하며 소스 사용을 만료시킨다', async () => {
    const f = await fixture();
    const job = await f.service.create(f.owner, request);
    const ready = await f.ready(job.id);
    await f.history.recover();
    const after = await f.history.get(job.id, f.owner);
    expect(after.status).toBe('EXPIRED');
    expect(after.provenance).toEqual(ready.provenance);
    await expect(f.history.get(job.id, f.other)).rejects.toBeInstanceOf(GitError);
  });

  it('Git 소스로 비교와 dry-run을 완료하고 snapshot/run/승인 작업에 같은 출처와 payload를 보존한다', async () => {
    const f = await fixture({ executeSf: true });
    const imported = await f.service.create(f.owner, request);
    const ready = await f.ready(imported.id);
    const sourceId = `git:${imported.id}`;
    const comparison = await f.server.sfudRuntime.comparisons.create({ projectId: sourceId, manifest: 'manifest/package.xml',
      leftSourceId: 'org:target', rightSourceId: sourceId, strict: false, showIdentical: false, createdBy: f.owner });
    await f.server.sfudRuntime.comparisonQueue.onIdle();
    const result = await f.server.sfudRuntime.comparisonJobs.getRequired(comparison.id);
    expect(result.status, result.errorMessage).toBe('SUCCEEDED');
    expect(JSON.parse(await readFile(path.join(result.runDirectory!, 'right/snapshot.json'), 'utf8')).provenance).toEqual(ready.provenance);
    const dryRun = await f.server.sfudRuntime.dryRuns.create({ projectId: sourceId, manifest: 'manifest/package.xml',
      sourceId, targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [], testClassSuffix: '_Test',
      waitMinutes: 1, strict: false, createdBy: f.owner, clientRequestId: 'git-dry-run-fixture' });
    await f.server.sfudRuntime.deploymentQueue.onIdle();
    await f.server.sfudRuntime.deploymentCoordinator.flushCompletions();
    const prepared = await f.server.sfudRuntime.deploymentJobs.getRequired(dryRun.id);
    expect(prepared.status, prepared.errorMessage).toBe('APPROVAL_PENDING');
    expect(prepared.sourceSnapshot?.source?.provenance).toEqual(ready.provenance);
    const snapshot = JSON.parse(await readFile(path.join(prepared.runDirectory!, 'right/snapshot.json'), 'utf8'));
    expect(snapshot.provenance).toEqual(ready.provenance);
    expect(JSON.parse(await readFile(path.join(prepared.runDirectory!, 'run.json'), 'utf8')).sourceSnapshot.source.provenance).toEqual(ready.provenance);
    const approved = await f.server.sfudRuntime.deploymentJobs.approveAndQueueDeployment({ dryRunJobId: prepared.id,
      approvedBy: f.owner, payloadChecksum: prepared.payloadChecksum, targetAlias: 'target', confirmation: '실제 배포' });
    expect(approved.sourceSnapshot).toEqual(prepared.sourceSnapshot);
    expect(await f.server.sfudRuntime.jobAccess.canAccess('deployment', approved.id, f.other)).toBe(false);
    // A new import resolves a different commit without touching the approved payload.
    vi.mocked(f.provider.resolveCommit).mockResolvedValueOnce('2'.repeat(40));
    const next = await f.service.create(f.owner, { ...request, expectedCommitSha: '2'.repeat(40) });
    expect((await f.ready(next.id)).provenance?.commitSha).toBe('2'.repeat(40));
    await f.service.remove(imported.id, f.owner);
    expect(await sha256DirectoryV2(snapshot.packageRoot as string)).toBe(prepared.payloadChecksum);
    const current = await f.server.sfudRuntime.deploymentJobs.getRequired(approved.id);
    expect(current.sourceSnapshot?.source?.provenance?.commitSha).toBe(sha);
    const detail = await f.server.inject({ url: `/api/v1/deployment-jobs/${approved.id}`, headers: f.headers });
    expect(detail.json()).toMatchObject({ job: { source: { id: sourceId, provenance: ready.provenance }, manifest: 'manifest/package.xml' } });
  });

  it('Git source를 Salesforce org 대상처럼 사용하는 dry-run과 direct API를 모두 거부한다', async () => {
    const f = await fixture();
    const imported = await f.service.create(f.owner, request);
    await f.ready(imported.id);
    const sourceId = `git:${imported.id}`;

    const payload = {
      projectId: sourceId,
      manifest: 'manifest/package.xml',
      sourceId,
      targetOrgId: sourceId,
      testLevel: 'NoTestRun' as const,
      tests: [] as string[],
      testClassSuffix: '_Test',
      waitMinutes: 1,
      strict: false,
      createdBy: f.owner,
      clientRequestId: 'git-target-rejected',
    };
    await expect(f.server.sfudRuntime.dryRuns.create(payload)).rejects.toThrow('배포 대상은 Salesforce org여야 합니다.');
    const apiPayload = {
      projectId: payload.projectId, manifest: payload.manifest, sourceId: payload.sourceId, targetOrgId: payload.targetOrgId,
      testLevel: payload.testLevel, tests: payload.tests, waitMinutes: payload.waitMinutes, strict: payload.strict,
    };

    const dryRunResponse = await f.server.inject({ method: 'POST', url: '/api/v1/deployments/dry-run',
      headers: { ...f.headers, 'idempotency-key': 'git-target-api-dry-run' }, payload: apiPayload });
    expect(dryRunResponse.statusCode, dryRunResponse.body).toBe(400);
    expect(dryRunResponse.json()).toMatchObject({ error: { code: 'INVALID_DRY_RUN_REQUEST', message: 'Git 저장소는 비교 전용입니다. Dry-run과 배포 대상은 Salesforce org여야 합니다.' } });

    const directResponse = await f.server.inject({ method: 'POST', url: '/api/v1/deployments/direct',
      headers: { ...f.headers, 'idempotency-key': 'git-target-api-direct' }, payload: {
        ...apiPayload, targetConfirmation: 'target', confirmation: '실제 배포',
      } });
    expect(directResponse.statusCode, directResponse.body).toBe(400);
    expect(directResponse.json()).toMatchObject({ error: { code: 'DIRECT_DEPLOYMENT_DENIED', message: 'Git 저장소는 비교 전용입니다. Dry-run과 배포 대상은 Salesforce org여야 합니다.' } });
  });

  it('준비된 Git source를 비교의 left에 두고 Salesforce org를 right에 두어 queue 실행과 출처를 보존한다', async () => {
    const f = await fixture({ executeSf: true });
    const imported = await f.service.create(f.owner, request);
    const ready = await f.ready(imported.id);
    const sourceId = `git:${imported.id}`;
    const comparison = await f.server.sfudRuntime.comparisons.create({
      scope: 'all', metadataType: 'ApexClass', leftSourceId: sourceId, rightSourceId: 'org:target',
      strict: false, showIdentical: false, createdBy: f.owner,
    });
    await f.server.sfudRuntime.comparisonQueue.onIdle();
    const result = await f.server.sfudRuntime.comparisonJobs.getRequired(comparison.id);
    expect(result.status, result.errorMessage).toBe('SUCCEEDED');
    expect(result.sourceSnapshot?.left?.provenance).toEqual(ready.provenance);
  });
});
