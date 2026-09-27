import { selectedGitEntries, validateGitProjectConfiguration } from './git-project-validator.js';
import type { GitCache } from './git-cache.js';
import { requireGitMetadataType } from './git-metadata-selection.js';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { WorkspaceProject, WorkspaceSource } from '../api/workspace-contracts.js';
import { GitImportRepository, type GitImportRecord, type GitImportRequest } from '../storage/git-import-repository.js';
import { ManagedProjectQuotaError, ManagedProjectService, type ManagedProject } from '../web/server/managed-project-service.js';
import { GitClient, type GitFetchOptions } from './git-client.js';
import { GitError } from './git-errors.js';
import { GitMaterializer } from './git-materializer.js';
import type { GitObjectReader } from './git-object-store.js';
import type { GitProvider, GitRepositoryInfo } from './git-provider.js';
import { assertCommitSha, normalizeRepository, validateGitRef, type GitProviderId } from './git-repository.js';
import { GithubProvider } from './providers/github-provider.js';
import { GitlabProvider } from './providers/gitlab-provider.js';
import { BitbucketProvider } from './providers/bitbucket-provider.js';
import type { GitRepositoryAccess, GitRepositoryAuthorization } from './git-repository-access.js';

interface Entry {
  record: GitImportRecord;
  directory: string;
  controller: AbortController;
  timer: NodeJS.Timeout;
  execution?: Promise<void>;
  cleanup?: Promise<void>;
  objects?: GitObjectReader;
  repository?: GitRepositoryInfo;
  authorization?: GitRepositoryAuthorization;
  roots: string[];
  chargedBytes: number;
  selecting: boolean;
  cacheLease?: Awaited<ReturnType<GitCache['acquire']>>;
}
interface Options {
  cache?: GitCache;
  access?: GitRepositoryAccess;
  enabled?: boolean;
  providers?: Record<GitProviderId, GitProvider>;
  client?: { fetch(options: GitFetchOptions): Promise<GitObjectReader> };
  concurrency?: number;
  timeoutMs?: number;
  maximumPackBytes?: number;
}
const inProgress = ['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'] as const;

export class GitImportService {
  private readonly entries = new Map<string, Entry>();
  private readonly sources = new Map<string, WorkspaceSource>();
  private readonly admissions = new Map<string, number>();
  private readonly queue: { entry: Entry; work: () => Promise<void> }[] = [];
  private readonly providers: Record<GitProviderId, GitProvider>;
  private readonly client: NonNullable<Options['client']>;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly maximumPackBytes: number;
  private readonly access: GitRepositoryAccess | undefined;
  private readonly enabled: boolean;
  private readonly cache: GitCache | undefined;
  private active = 0;
  private readonly warming = new Map<AbortController, Promise<{ commitSha: string; syncedAt: string }>>();
  private closed = false;

  public constructor(private readonly history: GitImportRepository,
    private readonly projects: ManagedProjectService, options: Options = {}) {
    this.cache = options.cache;
    this.providers = options.providers ?? { github: new GithubProvider(), gitlab: new GitlabProvider(), bitbucket: new BitbucketProvider() };
    this.client = options.client ?? new GitClient();
    this.concurrency = options.concurrency ?? 2;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.maximumPackBytes = options.maximumPackBytes ?? 100 * 1024 * 1024;
    this.access = options.access;
    this.enabled = options.enabled ?? true;
    if (![this.concurrency, this.timeoutMs, this.maximumPackBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new GitError('GIT_QUOTA_EXCEEDED');
    }
  }

  public async inspect(input: Pick<GitImportRequest, 'provider' | 'repositoryPath' | 'connectionId'>,
    signal?: AbortSignal, owner?: string): Promise<GitRepositoryInfo> {
    return (await this.authorize(input, owner, signal)).repository;
  }

  private async authorize(input: Pick<GitImportRequest, 'provider' | 'repositoryPath' | 'connectionId'>,
    owner?: string, signal?: AbortSignal): Promise<{ repository: GitRepositoryInfo; authorization?: GitRepositoryAuthorization }> {
    if (!this.enabled) throw new GitError('PROVIDER_NOT_CONFIGURED');
    const address = normalizeRepository(input.repositoryPath, input.provider);
    if (input.connectionId !== undefined) {
      if (this.access === undefined) throw new GitError('PROVIDER_NOT_CONFIGURED');
      if (owner === undefined) throw new GitError('GIT_CONNECTION_REQUIRED');
      const authorization = await this.access.authorize(owner, input.connectionId, address, this.providers[input.provider], signal);
      return { repository: authorization.repository, authorization };
    }
    const repository = await this.providers[input.provider].inspect(address, undefined, signal);
    if (repository.private) throw new GitError('GIT_CONNECTION_REQUIRED');
    return { repository };
  }

  public async refs(input: Pick<GitImportRequest, 'provider' | 'repositoryPath' | 'connectionId'>,
    kind: 'branch' | 'tag', cursor?: string, owner?: string) {
    const { repository, authorization } = await this.authorize(input, owner);
    const result = await this.providerFor(authorization, input.provider).listRefs(repository, kind, cursor, authorization?.apiCredential);
    await authorization?.assertCurrent();
    return result;
  }

  public async create(owner: string, input: GitImportRequest, isolation?: { sessionId: string; jobId: string; side: string }): Promise<GitImportRecord> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    if (!this.enabled) throw new GitError('PROVIDER_NOT_CONFIGURED');
    const address = normalizeRepository(input.repositoryPath, input.provider);
    const ref = validateGitRef(input.ref);
    assertCommitSha(input.expectedCommitSha);
    if (input.metadataType !== undefined) requireGitMetadataType(input.metadataType);
    const ownerCount = [...this.entries.values()].filter((entry) => entry.record.ownerUserId === owner).length;
    if (ownerCount + (this.admissions.get(owner) ?? 0) >= 3
      || this.entries.size + [...this.admissions.values()].reduce((a, b) => a + b, 0) >= 20) throw new GitError('GIT_QUOTA_EXCEEDED');
    this.admissions.set(owner, (this.admissions.get(owner) ?? 0) + 1);
    let allocation: Awaited<ReturnType<ManagedProjectService['begin']>> | undefined;
    try {
      if (input.connectionId !== undefined) {
        if (this.access === undefined) throw new GitError('PROVIDER_NOT_CONFIGURED');
        await this.access.validate(owner, input.connectionId, address);
      }
      allocation = await this.projects.begin(owner, isolation);
      if (this.closed) throw new GitError('IMPORT_CANCELLED');
      const record = await this.history.create(allocation.id, owner, { ...input, repositoryPath: address.repositoryPath, ref });
      const entry: Entry = {
        record, directory: allocation.directory, controller: new AbortController(), roots: [], chargedBytes: 0, selecting: false,
        timer: setTimeout(() => { void this.cancel(record.id, owner, true).catch(() => undefined); }, this.timeoutMs),
      };
      entry.timer.unref();
      this.entries.set(record.id, entry);
      if (this.closed) { await this.cancel(record.id, owner); throw new GitError('IMPORT_CANCELLED'); }
      this.enqueue(entry, () => this.fetch(entry));
      return record;
    } catch (error) {
      if (allocation !== undefined) await this.projects.discard(allocation.id, owner).catch(() => undefined);
      throw error;
    } finally {
      const remaining = (this.admissions.get(owner) ?? 1) - 1;
      if (remaining === 0) this.admissions.delete(owner); else this.admissions.set(owner, remaining);
    }
  }

  public async warm(owner: string, input: GitImportRequest): Promise<{ commitSha: string; syncedAt: string }> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    if (this.cache === undefined) throw new GitError('PROVIDER_NOT_CONFIGURED');
    if (this.warming.size >= 2) throw new GitError('GIT_QUOTA_EXCEEDED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const work = this.warmRepository(owner, input, controller.signal);
    this.warming.set(controller, work);
    try { return await work; }
    finally { clearTimeout(timer); this.warming.delete(controller); }
  }

  private async warmRepository(owner: string, input: GitImportRequest, signal: AbortSignal) {
    if (input.ref.kind !== 'branch') throw new GitError('INVALID_REF');
    validateGitRef(input.ref);
    const { repository, authorization } = await this.authorize(input, owner, signal);
    const sha = await this.providerFor(authorization, input.provider).resolveCommit(repository, input.ref, authorization?.apiCredential, signal);
    const lease = await this.cache!.acquire([owner, input.connectionId ?? 'public', repository.provider, repository.host, repository.repositoryId], signal);
    try {
      const objects = await this.client.fetch({ directory: lease.directory, repository, commitSha: sha,
        partial: true, ref: input.ref.name, signal, onDiskUsage: lease.checkBytes,
        ...(authorization === undefined ? {} : { credentialProvider: authorization.credentialProvider }) });
      const tree = await objects.listTree(sha, signal);
      const entries = selectedGitEntries(tree, input.projectRoot ?? '.', true);
      const config = entries.find((entry) => entry.path === 'sfdx-project.json');
      if (config === undefined || config.type !== 'blob' || !['100644', '100755'].includes(config.mode)) throw new GitError('DX_PROJECT_NOT_FOUND');
      validateGitProjectConfiguration(await objects.readBlob(config.objectId, 256 * 1024, signal), entries);
      await authorization?.assertCurrent();
      if (signal.aborted) throw new GitError('IMPORT_CANCELLED');
      return { commitSha: sha, syncedAt: new Date().toISOString() };
    } finally { await lease.release(); }
  }

  public async prepareLatest(owner: string, input: GitImportRequest,
    isolation?: { sessionId: string; jobId: string; side: string }): Promise<GitImportRecord> {
    const { repository, authorization } = await this.authorize(input, owner);
    const sha = await this.providerFor(authorization, input.provider).resolveCommit(repository, input.ref, authorization?.apiCredential);
    await authorization?.assertCurrent();
    const record = await this.create(owner, { ...input, expectedCommitSha: sha }, isolation);
    while (true) {
      const current = await this.get(record.id, owner);
      if (current.status === 'READY') return current;
      if (current.status === 'SELECTING') {
        await this.cancel(current.id, owner);
        throw new GitError('PROJECT_SELECTION_REQUIRED');
      }
      if (!inProgress.some((status) => status === current.status)) throw new GitError(current.errorCode ?? 'IMPORT_CANCELLED');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  public async get(id: string, owner: string): Promise<GitImportRecord> {
    const record = await this.history.get(id, owner);
    if (record.status === 'READY' && !this.projects.list().some((project) => project.id === id)) {
      this.sources.delete(id);
      await this.history.transition(id, owner, ['READY'], 'EXPIRED', { errorCode: 'IMPORT_EXPIRED' });
      return this.history.get(id, owner);
    }
    return record;
  }

  public async list(owner: string): Promise<GitImportRecord[]> {
    return Promise.all((await this.history.list(owner)).map((record) => this.get(record.id, owner)));
  }

  public async select(id: string, owner: string, root: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.record.ownerUserId !== owner) throw new GitError('IMPORT_EXPIRED');
    if (!entry.selecting || !entry.roots.includes(root) || entry.controller.signal.aborted) throw new GitError('PROJECT_SELECTION_REQUIRED');
    entry.selecting = false; // Reserve synchronously, before any await or queue tick.
    this.enqueue(entry, () => this.materialize(entry, root));
  }

  public async cancel(id: string, owner: string, timeout = false): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.record.ownerUserId !== owner) throw new GitError('IMPORT_EXPIRED');
    entry.controller.abort();
    clearTimeout(entry.timer);
    await entry.execution;
    // Queued entries have no execution promise. An aborted queue item can never run.
    await this.history.transition(id, owner, inProgress, timeout ? 'FAILED' : 'CANCELLED',
      { errorCode: timeout ? 'IMPORT_TIMEOUT' : 'IMPORT_CANCELLED' }).catch(async (error: unknown) => {
      const record = await this.history.get(id, owner);
      if (!['FAILED', 'CANCELLED'].includes(record.status)) throw error;
    });
    await this.cleanup(entry);
  }

  public async remove(id: string, owner: string): Promise<void> {
    const record = await this.get(id, owner);
    if (inProgress.some((status) => status === record.status)) { await this.cancel(id, owner); return; }
    if (record.status === 'READY') await this.projects.discard(id, owner);
    await this.history.transition(id, owner, [record.status], 'DELETED');
    this.sources.delete(id);
  }

  public listSources(owner: string): WorkspaceSource[] {
    const live = new Map(this.projects.list().filter((project) => project.ownerUserId === owner).map((project) => [project.id, project]));
    return [...this.sources.entries()].flatMap(([id, source]) => {
      const project = live.get(id);
      return project === undefined ? [] : [{ ...source, expiresAt: new Date(project.expiresAt).toISOString() }];
    });
  }

  public listProjects(owner: string): WorkspaceProject[] {
    return this.projects.list().filter((project) => project.origin === 'git' && project.ownerUserId === owner && this.sources.has(project.id))
      .map(({ id, displayName, manifests }) => ({ id: `git:${id}`, displayName, manifests }));
  }

  public resolve(id: string, owner?: string): ManagedProject {
    if (!this.sources.has(id)) throw new GitError('IMPORT_EXPIRED');
    return this.projects.resolve(id, owner);
  }

  public sourceForPath(realPath: string): WorkspaceSource | undefined {
    const project = this.projects.list().find((candidate) => candidate.realPath === realPath && candidate.origin === 'git');
    return project === undefined ? undefined : this.sources.get(project.id);
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.warming.keys()) controller.abort();
    await Promise.allSettled(this.warming.values());
    await Promise.all([...this.entries.values()].map((entry) => this.cancel(entry.record.id, entry.record.ownerUserId)));
  }

  public async cancelConnection(owner: string, connectionId: string): Promise<void> {
    await Promise.all([...this.entries.values()]
      .filter((entry) => entry.record.ownerUserId === owner && entry.record.connectionId === connectionId)
      .map((entry) => this.cancel(entry.record.id, owner)));
  }

  private enqueue(entry: Entry, work: () => Promise<void>): void {
    this.queue.push({ entry, work });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const { entry, work } = this.queue.shift()!;
      if (entry.controller.signal.aborted) continue;
      this.active++;
      entry.execution = work().catch(async (error: unknown) => {
        if (entry.controller.signal.aborted) return; // cancel owns cleanup and final state.
        const code = error instanceof GitError ? error.code
          : error instanceof ManagedProjectQuotaError ? 'GIT_QUOTA_EXCEEDED' : 'GIT_PROCESS_FAILED';
        await this.history.transition(entry.record.id, entry.record.ownerUserId, inProgress, 'FAILED', { errorCode: code });
        await this.cleanup(entry);
      }).finally(() => { this.active--; this.drain(); });
      // Keep a handled promise even if a database/disk failure interrupts cleanup.
      void entry.execution.catch(() => undefined);
    }
  }

  private async fetch(entry: Entry): Promise<void> {
    const { record, controller } = entry;
    await this.history.transition(record.id, record.ownerUserId, ['QUEUED'], 'FETCHING');
    const { repository, authorization } = await this.authorize(record, record.ownerUserId, controller.signal);
    const sha = await this.providerFor(authorization, record.provider).resolveCommit(repository, record.ref, authorization?.apiCredential, controller.signal);
    if (sha !== record.expectedCommitSha) throw new GitError('REF_CHANGED');
    await authorization?.assertCurrent();
    entry.repository = repository;
    if (authorization !== undefined) entry.authorization = authorization;
if (this.cache !== undefined) entry.cacheLease = await this.cache.acquire([
      record.ownerUserId, record.connectionId ?? 'public', repository.provider, repository.host, repository.repositoryId,
    ], controller.signal);
    entry.objects = await this.client.fetch({ directory: entry.cacheLease?.directory ?? entry.directory, repository, commitSha: sha, signal: controller.signal, partial: record.metadataType !== undefined,
      ...(record.ref.kind === 'branch' ? { ref: record.ref.name } : {}),
      ...(authorization === undefined ? {} : { credentialProvider: authorization.credentialProvider }),
      onDiskUsage: (bytes) => {
        if (entry.cacheLease !== undefined) { entry.cacheLease.checkBytes(bytes); return; }
        if (bytes > this.maximumPackBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
        if (bytes > entry.chargedBytes) { this.projects.recordBytes(record.id, bytes - entry.chargedBytes); entry.chargedBytes = bytes; }
      } });
    await authorization?.assertCurrent();
    this.assertActive(entry);
    entry.roots = await new GitMaterializer(entry.objects).discover(sha, controller.signal);
    if (entry.roots.length === 0) throw new GitError('DX_PROJECT_NOT_FOUND');
    if (record.projectRoot !== undefined || entry.roots.length === 1) {
      await this.materialize(entry, record.projectRoot ?? entry.roots[0]!);
    } else {
      this.assertActive(entry);
      await this.history.transition(record.id, record.ownerUserId, ['FETCHING'], 'SELECTING', { projectRoots: entry.roots });
      entry.selecting = true;
    }
  }

  private async materialize(entry: Entry, root: string): Promise<void> {
    const { record } = entry;
    this.assertActive(entry);
    await entry.authorization?.assertCurrent();
    if (!entry.roots.includes(root)) throw new GitError('DX_PROJECT_NOT_FOUND');
    await this.history.transition(record.id, record.ownerUserId, ['FETCHING', 'SELECTING'], 'MATERIALIZING', { projectRoots: entry.roots });
    const projectPath = path.join(entry.directory, 'project');
    const result = await new GitMaterializer(entry.objects!).materialize(record.expectedCommitSha, root, projectPath,
      { signal: entry.controller.signal, ...(record.metadataType === undefined ? {} : { metadataType: record.metadataType }), onBytes: (bytes) => this.projects.recordBytes(record.id, bytes) });
    await entry.authorization?.assertCurrent();
    this.assertActive(entry);
    if (entry.cacheLease !== undefined) { await entry.cacheLease.release(); delete entry.cacheLease; }
    else await rm(path.join(entry.directory, 'repository.git'), { recursive: true, force: true });
    this.projects.releasePendingBytes(record.id, entry.chargedBytes);
    const repository = entry.repository!;
    const provenance: NonNullable<WorkspaceSource['provenance']> = {
      provider: repository.provider, host: repository.host, repositoryId: repository.repositoryId, repositoryPath: repository.repositoryPath,
      ...(record.metadataType === undefined ? {} : { metadataType: record.metadataType }),
      refType: record.ref.kind, refName: record.ref.name, commitSha: record.expectedCommitSha, projectRoot: root,
      importedAt: new Date().toISOString(), importedContentChecksum: result.checksum, sourceOwnerUserId: record.ownerUserId, importId: record.id,
    };
    await this.projects.complete(record.id, record.ownerUserId, { id: record.id, realPath: projectPath,
      displayName: repository.repositoryPath, manifests: result.manifests, origin: 'git' });
    this.assertActive(entry);
    await this.history.transition(record.id, record.ownerUserId, ['MATERIALIZING'], 'READY', { provenance, sizeBytes: result.sizeBytes });
    // Cancellation may arrive while committing READY. Do not publish a source.
    if (entry.controller.signal.aborted) {
      await this.history.transition(record.id, record.ownerUserId, ['READY'], 'CANCELLED', { errorCode: 'IMPORT_CANCELLED' });
      return;
    }
    this.sources.set(record.id, { id: `git:${record.id}`, kind: 'local', location: 'git', label: repository.repositoryPath, provenance });
    clearTimeout(entry.timer);
    this.entries.delete(record.id);
  }

  private assertActive(entry: Entry): void {
    if (entry.controller.signal.aborted) throw new GitError('IMPORT_CANCELLED');
  }

  private providerFor(authorization: GitRepositoryAuthorization | undefined, provider: GitProviderId): GitProvider {
    if (authorization === undefined) return this.providers[provider];
    if (authorization.remote !== undefined) return authorization.remote;
    // A connection without an API credential must be repository-bound. Never
    // silently send that request to a provider REST API.
    if (authorization.apiCredential === undefined) throw new GitError('GIT_CONNECTION_REQUIRED');
    return this.providers[provider];
  }

  private async cleanup(entry: Entry): Promise<void> {
    clearTimeout(entry.timer);
    if (entry.cacheLease !== undefined) { await entry.cacheLease.release(); delete entry.cacheLease; }
    entry.cleanup ??= this.projects.discard(entry.record.id, entry.record.ownerUserId)
      .then(() => { this.entries.delete(entry.record.id); })
      .catch((error: unknown) => { delete entry.cleanup; throw error; });
    await entry.cleanup;
  }
}
