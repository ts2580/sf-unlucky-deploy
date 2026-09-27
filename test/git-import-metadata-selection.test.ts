import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import { GitImportService } from '../src/git/git-import-service.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import type { GitProvider } from '../src/git/git-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';

const cleanups: (() => Promise<void>)[] = [];
const sha = '1'.repeat(40);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function objects(): GitObjectReader {
  const files = new Map<string, Buffer>([
    ['sfdx-project.json', Buffer.from('{"packageDirectories":[{"path":"force-app"}],"sourceApiVersion":"64.0"}')],
    ['.forceignore', Buffer.from('**/ignored/**\n')],
    ['force-app/main/default/objects/Account/Account.object-meta.xml', Buffer.from('<CustomObject/>\n')],
    ['force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', Buffer.from('<CustomField/>\n')],
    ['force-app/main/default/objects/Account/validationRules/Nope.validationRule-meta.xml', Buffer.from('<ValidationRule/>\n')],
  ]);
  return {
    async listTree() {
      return [...files].map(([file, content]) => ({
        path: file, objectId: file, mode: '100644', type: 'blob' as const, size: content.length,
      }));
    },
    async readBlob(id) {
      return files.get(id)!;
    },
    async prepareBlobs() {},
  };
}

describe('Git metadata selection persistence', { timeout: 30_000 }, () => {
  it('metadataType를 DB/provenance에 보존하고 partial fetch를 요청한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-metadata-service-'));
    const server = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      assetsDirectory: '/missing',
      databasePath: path.join(root, 'sfud.db'),
      bootstrapToken: 'git-metadata-bootstrap',
      sfClient: { async runJson() { throw new Error('SF CLI must not be called'); } },
    });
    const owner = await server.sfudRuntime.auth.bootstrapAdmin({
      bootstrapToken: 'git-metadata-bootstrap',
      email: 'metadata-owner@example.com',
      displayName: 'metadata owner',
      password: 'git metadata test password',
    });
    const repository = normalizeRepository('sample/project', 'github');
    const provider: GitProvider = {
      id: 'github',
      inspect: vi.fn(async () => ({ ...repository, repositoryId: '123', private: false, defaultBranch: 'main' })),
      resolveCommit: vi.fn(async () => sha),
      listRefs: vi.fn(async () => ({ refs: [{ kind: 'branch' as const, name: 'main', commitSha: sha }] })),
    };
    const fetch = vi.fn(async (options: GitFetchOptions): Promise<GitObjectReader> => {
      options.onDiskUsage(100);
      return objects();
    });
    const history = new GitImportRepository(server.sfudRuntime.store.database);
    const service = new GitImportService(history, server.sfudRuntime.workspace.managedProjects, {
      providers: { github: provider, gitlab: provider, bitbucket: provider },
      client: { fetch },
    });
    server.sfudRuntime.gitImports = service;
    server.sfudRuntime.workspace.gitImports = service;
    cleanups.push(async () => {
      await service.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    });

    const queued = await service.create(owner.user.id, {
      provider: 'github',
      repositoryPath: 'sample/project',
      ref: { kind: 'branch', name: 'main' },
      expectedCommitSha: sha,
      projectRoot: '.',
      metadataType: 'CustomField',
    });
    expect(queued.metadataType).toBe('CustomField');
    await vi.waitFor(async () => expect((await history.get(queued.id, owner.user.id)).status).toBe('READY'));
    const ready = await history.get(queued.id, owner.user.id);
    expect(ready.metadataType).toBe('CustomField');
    expect(ready.provenance).toMatchObject({ metadataType: 'CustomField', projectRoot: '.' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].partial).toBe(true);
  });
});
