import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from '../src/sources/workspace-service.js';
import type { SourceProvider, SourcePreparation } from '../src/sources/ports.js';
import type { SourceDescriptor } from '../src/sources/model.js';
import { ManagedProjectService } from '../src/sources/managed-project-service.js';
import { createGitSourceProvider } from '../src/git/git-source-provider.js';
import type { GitImportRecord } from '../src/git/storage/git-import-repository.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const input: SourcePreparation = { ownerUserId: 'owner', scope: 'all', metadataType: 'ApexClass', sessionId: 'session', jobId: 'job', side: 'right' };

async function storage() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-provider-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projects = new ManagedProjectService(root, 1000, 1000);
  cleanup.push(() => projects.close());
  const allocation = await projects.begin('owner');
  const project = await projects.complete(allocation.id, 'owner', {
    id: allocation.id, displayName: 'prepared', realPath: allocation.directory, manifests: [],
  });
  return { projects, project };
}

describe('source provider boundary', () => {
  it('resolves an injected non-Git source and keeps its snapshot independent of provider mutations', async () => {
    const { projects, project } = await storage();
    const descriptor: SourceDescriptor = { id: `fixture:${project.id}`, kind: 'local', label: 'fixed source' };
    const release = vi.fn();
    const prepare = vi.fn(async () => ({ id: descriptor.id, release, discard: async () => release() }));
    const provider: SourceProvider = {
      accepts: (id) => id.startsWith('fixture:'), requiresPreparation: () => false,
      prepare, resolveProject: async (_id, owner) => projects.resolve(project.id, owner),
      managedProjectIds: () => [], sourceForPath: () => descriptor,
      metadataTypes: async () => [],
    };
    const workspace = await WorkspaceService.create({ runJson: async () => ({}) }, process.cwd(), [], {}, undefined, () => [provider]);
    cleanup.push(() => workspace.close());
    const prepared = await workspace.prepareSource(descriptor.id, input);
    expect(prepare).toHaveBeenCalledWith(descriptor.id, input);
    const resolved = await workspace.resolveSourceSnapshot(prepared.id, 'owner');
    descriptor.label = 'changed later';
    expect(resolved.snapshot.label).toBe('fixed source');
    expect(resolved.source).toBe(`local:${project.realPath}`);
    await expect(workspace.resolveSourceSnapshot(prepared.id, 'another-user')).rejects.toThrow();
    prepared.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a prepared Git source pinned until ownership transfers to the queued job', async () => {
    const { projects, project } = await storage();
    const record: GitImportRecord = { id: project.id, ownerUserId: 'owner', provider: 'github', repositoryPath: 'owner/repo',
      ref: { kind: 'branch', name: 'main' }, expectedCommitSha: 'a'.repeat(40), status: 'READY', projectRoots: ['.'],
      sizeBytes: 0, createdAt: '', updatedAt: '' };
    const remove = vi.fn((id: string, owner: string) => projects.discard(id, owner));
    const prepare = vi.fn(async () => record);
    const provider = createGitSourceProvider(() => ({ remove, resolve: (id, owner) => projects.resolve(id, owner), sourceForPath: () => undefined }),
      () => ({ prepare, get: vi.fn() }), projects);
    const prepared = await provider.prepare('git-registered:registration', input);
    await expect(projects.discard(project.id, 'owner')).rejects.toThrow('작업에서 사용 중');
    const jobRelease = projects.pin([project.id], 'owner');
    prepared.release();
    prepared.release();
    await expect(projects.discard(project.id, 'owner')).rejects.toThrow('작업에서 사용 중');
    jobRelease();
    await prepared.discard();
    expect(remove).toHaveBeenCalledWith(project.id, 'owner');
    expect(projects.list()).toEqual([]);
  });

  it('removes a newly prepared import if acquiring its preparation lease fails', async () => {
    const remove = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => ({ id: 'new-import' } as GitImportRecord));
    const provider = createGitSourceProvider(() => ({ remove, resolve: vi.fn(), sourceForPath: () => undefined }),
      () => ({ prepare, get: vi.fn() }), { pin: () => { throw new Error('expired before pin'); } });
    await expect(provider.prepare('git-registered:registration', input)).rejects.toThrow('expired before pin');
    expect(remove).toHaveBeenCalledWith('new-import', 'owner');
    await expect(provider.prepare('git-registered:registration', { ...input, scope: 'manifest' })).rejects.toThrow('메타데이터 타입');
    expect(prepare).toHaveBeenCalledOnce();
  });
});
