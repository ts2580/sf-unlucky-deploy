import { access, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createWebRuntime, type WebRuntime } from '../src/web/server/runtime.js';
import { GitImportService } from '../src/git/git-import-service.js';
import { GitClient, type GitFetchOptions } from '../src/git/git-client.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import type { GitProvider } from '../src/git/git-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';
import type { SfClient } from '../src/salesforce/sf-client.js';

const commitSha = '1'.repeat(40);
const request = {
  provider: 'github' as const,
  repositoryPath: 'sample/project',
  ref: { kind: 'branch' as const, name: 'main' },
  expectedCommitSha: commitSha,
};
const manifest = '<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>Hello</members><name>ApexClass</name></types><version>61.0</version></Package>';

function objects(): GitObjectReader {
  const files = new Map<string, Buffer>([
    ['sfdx-project.json', Buffer.from('{"packageDirectories":[{"path":"force-app"}],"sourceApiVersion":"61.0"}')],
    ['force-app/main/default/classes/Hello.cls', Buffer.from('public class Hello {}')],
    ['force-app/main/default/classes/Hello.cls-meta.xml', Buffer.from('<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>61.0</apiVersion><status>Active</status></ApexClass>')],
    ['manifest/package.xml', Buffer.from(manifest)],
  ]);
  return {
    async listTree() {
      return [...files].map(([file, content]) => ({ path: file, objectId: file, mode: '100644', type: 'blob', size: content.length }));
    },
    async readBlob(id) { return files.get(id)!; },
  };
}

function fakeProvider(): GitProvider {
  return {
    id: 'github',
    inspect: vi.fn(async () => ({
      ...normalizeRepository(request.repositoryPath, 'github'), repositoryId: '123', private: false, defaultBranch: 'main',
    })),
    resolveCommit: vi.fn(async () => commitSha),
    listRefs: vi.fn(async () => ({ refs: [{ ...request.ref, commitSha }] })),
  };
}

describe('Git import runtime restart recovery', { timeout: 30_000 }, () => {
  it('같은 SQLite를 다시 열면 READY와 pending import를 만료시키고 provenance·소유권을 보존하며 fetch 없이 source를 폐기한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-restart-'));
    const databasePath = path.join(root, 'sfud.db');
    const sfClient: SfClient = { runJson: vi.fn(async () => ({ result: {} })) };
    let first: WebRuntime | undefined;
    let second: WebRuntime | undefined;
    let injectedImports: GitImportService | undefined;
    let restoreGitFetch: (() => void) | undefined;
    try {
      first = await createWebRuntime(databasePath, 'git-restart-bootstrap', [], process.cwd(), sfClient);
      const owner = await first.auth.bootstrapAdmin({
        bootstrapToken: 'git-restart-bootstrap', email: 'restart-owner@example.com', displayName: 'Restart owner',
        password: 'restart test password',
      });
      const other = await first.auth.createManagedUser({
        actorUserId: owner.user.id, email: 'restart-other@example.com', displayName: 'Restart other',
        role: 'ADMIN', password: 'restart test password',
      });
      const fakeFetch = vi.fn(async (input: GitFetchOptions): Promise<GitObjectReader> => {
        input.onDiskUsage(100);
        return objects();
      });
      const provider = fakeProvider();
      const history = new GitImportRepository(first.store.database);
      const imports = new GitImportService(history, first.workspace.managedProjects, {
        providers: { github: provider, gitlab: provider, bitbucket: provider },
        client: { fetch: fakeFetch },
      });
      injectedImports = imports;
      first.gitImports = imports;
      first.workspace.gitImports = imports;

      const ready = await imports.create(owner.user.id, request);
      await vi.waitFor(async () => expect((await history.get(ready.id, owner.user.id)).status).toBe('READY'));
      const beforeRestart = await history.get(ready.id, owner.user.id);
      const oldSourcePath = await first.workspace.resolveSource(`git:${ready.id}`, owner.user.id);
      await access(oldSourcePath.slice('local:'.length));
      expect(beforeRestart.provenance).toMatchObject({ importId: ready.id, sourceOwnerUserId: owner.user.id, commitSha: commitSha });

      const pendingId = randomUUID();
      await history.create(pendingId, owner.user.id, request);
      expect((await history.get(pendingId, owner.user.id)).status).toBe('QUEUED');
      expect(fakeFetch).toHaveBeenCalledTimes(1);

      await first.shutdown();
      first = undefined;
      await injectedImports.close();
      injectedImports = undefined;
      await expect(access(oldSourcePath.slice('local:'.length))).rejects.toThrow();

      const gitFetchSpy = vi.spyOn(GitClient.prototype, 'fetch');
      restoreGitFetch = () => gitFetchSpy.mockRestore();
      second = await createWebRuntime(databasePath, undefined, [], process.cwd(), sfClient);
      expect(gitFetchSpy).not.toHaveBeenCalled();
      const reopened = new GitImportRepository(second.store.database);
      const recoveredReady = await reopened.get(ready.id, owner.user.id);
      const recoveredPending = await reopened.get(pendingId, owner.user.id);
      expect(recoveredReady.status).toBe('EXPIRED');
      expect(recoveredReady.errorCode).toBe('IMPORT_EXPIRED');
      expect(recoveredReady.provenance).toEqual(beforeRestart.provenance);
      expect(recoveredPending).toMatchObject({ status: 'EXPIRED', errorCode: 'IMPORT_EXPIRED' });
      await expect(second.workspace.resolveSource(`git:${ready.id}`, owner.user.id)).rejects.toThrow();
      await expect(reopened.get(ready.id, other.id)).rejects.toThrow();
      await expect(reopened.get(pendingId, other.id)).rejects.toThrow();
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    } finally {
      restoreGitFetch?.();
      await injectedImports?.close().catch(() => undefined);
      await second?.shutdown().catch(() => undefined);
      await first?.shutdown().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
