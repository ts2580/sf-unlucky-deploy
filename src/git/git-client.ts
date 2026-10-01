import type { GitCredentialProvider } from './git-credential-provider.js';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { GitError } from './git-errors.js';
import { assertCommitSha, normalizeRepository, validateGitRef, type GitRepositoryAddress } from './git-repository.js';
import { gitHostPolicyFromEnvironment, resolveGitHost, type GitHostPolicy } from './git-network.js';
import { createGitCredentialBridge } from './git-credential-bridge.js';
import { runIsolatedGit } from './git-process.js';
import { GitObjectStore } from './git-object-store.js';
import { runGitOperation } from './git-diagnostics.js';

export interface GitFetchOptions {
  directory: string;
  repository: GitRepositoryAddress;
  commitSha: string;
  partial?: boolean;
  ref?: string;
  credentialProvider?: GitCredentialProvider;
  signal?: AbortSignal;
  onDiskUsage: (bytes: number) => void;
}

export interface GitRemoteOptions {
  repository: GitRepositoryAddress;
  credentialProvider: GitCredentialProvider;
  signal?: AbortSignal;
}
let remoteChecks = 0;

export class GitClient {
  public constructor(private readonly hostPolicy: GitHostPolicy = gitHostPolicyFromEnvironment(),
    private readonly diagnosticsFile?: string) {}

  public async lsRemote(options: GitRemoteOptions): Promise<Buffer> {
    return runGitOperation(this.diagnosticsFile, undefined, 'ls-remote', () => this.lsRemoteInternal(options));
  }

  private async lsRemoteInternal(options: GitRemoteOptions): Promise<Buffer> {
    const repository = normalizeRepository(options.repository.cloneUrl, options.repository.provider);
    if (repository.repositoryPath !== options.repository.repositoryPath || repository.host !== options.repository.host) {
      throw new GitError('INVALID_REPOSITORY');
    }
    if (remoteChecks >= 20) throw new GitError('PROVIDER_RATE_LIMITED');
    remoteChecks++;
    let directory: string | undefined;
    try {
      const selected = await resolveGitHost(repository.host, this.hostPolicy);
      directory = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-refs-'));
      const bridge = await createGitCredentialBridge(directory, repository, await options.credentialProvider.getCredential());
      try {
        const ip = selected.family === 6 ? `[${selected.address}]` : selected.address;
        return await runIsolatedGit(['ls-remote', '--symref', '--', repository.cloneUrl, 'HEAD', 'refs/heads/*', 'refs/tags/*'], {
          cwd: directory, timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          additionalConfig: [`http.curloptResolve=${repository.host}:${new URL(repository.cloneUrl).port || '443'}:${ip}`, 'credential.useHttpPath=true', `credential.helper=${bridge.helperCommand}`],
          bridgeEnvironment: bridge.environment,
        });
      } finally { await bridge.close(); }
    } catch (error) {
      if (error instanceof GitError && error.code === 'GIT_PROCESS_FAILED') throw new GitError('GIT_REMOTE_UNAVAILABLE');
      throw error;
    } finally {
      remoteChecks--;
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }

  public async fetch(options: GitFetchOptions): Promise<GitObjectStore> {
    return runGitOperation(this.diagnosticsFile, undefined, 'fetch', () => this.fetchInternal(options));
  }

  private async fetchInternal(options: GitFetchOptions): Promise<GitObjectStore> {
    assertCommitSha(options.commitSha);
    if (options.ref !== undefined) validateGitRef({ kind: 'branch', name: options.ref });
    const repository = normalizeRepository(options.repository.cloneUrl, options.repository.provider);
    if (repository.repositoryPath !== options.repository.repositoryPath || repository.host !== options.repository.host) {
      throw new GitError('INVALID_REPOSITORY');
    }
    const selected = await resolveGitHost(repository.host, this.hostPolicy);
    const gitDirectory = path.join(options.directory, 'repository.git');
    const base = {
      cwd: options.directory, ...(options.signal === undefined ? {} : { signal: options.signal }),
      onDiskUsage: options.onDiskUsage,
    };
    await runIsolatedGit(['init', '--bare', gitDirectory], base);
    const bridge = options.credentialProvider === undefined ? undefined
      : await createGitCredentialBridge(options.directory, repository, await options.credentialProvider.getCredential());
    try {
      const ip = selected.family === 6 ? `[${selected.address}]` : selected.address;
      await runIsolatedGit(['fetch', '--depth=1', ...(options.partial === true ? ['--filter=blob:none'] : []), '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        '--', repository.cloneUrl, options.ref === undefined ? options.commitSha : `+refs/heads/${options.ref}:refs/remotes/origin/selected`], {
        ...base, gitDirectory,
        additionalConfig: [
          `http.curloptResolve=${repository.host}:${new URL(repository.cloneUrl).port || '443'}:${ip}`,
          ...(bridge === undefined ? [] : ['credential.useHttpPath=true', `credential.helper=${bridge.helperCommand}`]),
        ],
        ...(bridge === undefined ? {} : { bridgeEnvironment: bridge.environment }),
      });
      if (options.ref !== undefined) {
        const actual = await runIsolatedGit(['rev-parse', 'refs/remotes/origin/selected'], { ...base, gitDirectory });
        if (actual.toString('utf8').trim() !== options.commitSha) throw new GitError('REF_CHANGED');
      }
      if (options.partial === true) {
        // Remove the implicit promisor remote created by fetch. With some Git
        // versions, even batch-check can otherwise fail on missing blobs or
        // try lazy fetching. All blob transfers must use our bridge,
        // DNS pin, cancellation and quota checks below.
        await runIsolatedGit(['config', '--local', '--remove-section', `remote.${repository.cloneUrl}`], { ...base, gitDirectory });
      }
      const type = await runIsolatedGit(['cat-file', '-t', options.commitSha], { ...base, gitDirectory });
      if (type.toString('utf8').trim() !== 'commit') throw new GitError('INVALID_GIT_OBJECT');
      return new GitObjectStore(options.directory, gitDirectory, options.partial === true ? async (ids, signal) => runGitOperation(this.diagnosticsFile, undefined, 'fetch-lazy', async () => {
        for (const id of ids) assertCommitSha(id);
        const resolved = await resolveGitHost(repository.host, this.hostPolicy);
        const fetchBridge = options.credentialProvider === undefined ? undefined
          : await createGitCredentialBridge(options.directory, repository, await options.credentialProvider.getCredential());
        try {
          const pinnedIp = resolved.family === 6 ? `[${resolved.address}]` : resolved.address;
          await runIsolatedGit(['fetch', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
            '--stdin', '--', repository.cloneUrl], {
            ...base, gitDirectory, ...(signal === undefined ? {} : { signal }), input: Buffer.from(`${ids.join('\n')}\n`),
            // Match Git's promisor fetch: avoid commit negotiation for object
            // wants, and restore promisor context for this command only. The
            // normal reader deliberately has no remote (no implicit fetch).
            additionalConfig: ['fetch.negotiationAlgorithm=noop',
              `remote.${repository.cloneUrl}.promisor=true`,
              `remote.${repository.cloneUrl}.partialclonefilter=blob:none`,
              `http.curloptResolve=${repository.host}:${new URL(repository.cloneUrl).port || '443'}:${pinnedIp}`,
              ...(fetchBridge === undefined ? [] : ['credential.useHttpPath=true', `credential.helper=${fetchBridge.helperCommand}`])],
            ...(fetchBridge === undefined ? {} : { bridgeEnvironment: fetchBridge.environment }),
          });
        } finally { await fetchBridge?.close(); }
      }) : undefined);
    } finally { await bridge?.close(); }
  }
}
