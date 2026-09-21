import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitConnectionService } from '../src/git/git-connection-service.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import { GitImportService } from '../src/git/git-import-service.js';
import type { GitObjectReader } from '../src/git/git-object-store.js';
import { GitRepositoryAccess } from '../src/git/git-repository-access.js';
import type { ApiCredential } from '../src/git/git-credential-provider.js';
import type { GitProvider, GitRepositoryInfo } from '../src/git/git-provider.js';
import { normalizeRepository, type GitProviderId, type GitRepositoryAddress } from '../src/git/git-repository.js';
import { GitConnectionRepository } from '../src/storage/git-connection-repository.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { TokenVault } from '../src/git/token-vault.js';
import { UserRepository, type SfudUser } from '../src/storage/user-repository.js';
import { ManagedProjectService } from '../src/web/server/managed-project-service.js';

const stores: SqliteStore[] = [];
const roots: string[] = [];
const services: GitImportService[] = [];
const projectStores: ManagedProjectService[] = [];
const sha = '1'.repeat(40);
const changedSha = '2'.repeat(40);

afterEach(async () => {
  for (const service of services.splice(0)) await service.close().catch(() => undefined);
  for (const projects of projectStores.splice(0)) await projects.close().catch(() => undefined);
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FixtureOptions {
  provider?: GitProviderId;
  accessEnabled?: boolean;
  enabled?: boolean;
  repositoryPath?: string;
  remoteSha?: string;
  apiUsername?: string;
  expiresAt?: string;
  concurrency?: number;
  fetch?: (input: GitFetchOptions) => Promise<GitObjectReader>;
  resolveCommit?: string;
}
interface Fixture {
  store: SqliteStore;
  owner: SfudUser;
  other: SfudUser;
  connections: GitConnectionRepository;
  connection: Awaited<ReturnType<GitConnectionRepository['save']>>;
  connectionService: GitConnectionService;
  access: GitRepositoryAccess;
  history: GitImportRepository;
  service: GitImportService;
  provider: GitProvider;
  providerCalls: { inspect: string[]; refs: string[]; commits: string[] };
  remote: { lsRemote: ReturnType<typeof vi.fn> };
  fetch: ReturnType<typeof vi.fn>;
  address: GitRepositoryAddress;
  request: { provider: GitProviderId; repositoryPath: string; ref: { kind: 'branch'; name: string }; expectedCommitSha: string; connectionId: string };
}

function objects(): GitObjectReader {
  const files = new Map<string, Buffer>([
    ['sfdx-project.json', Buffer.from('{"packageDirectories":[{"path":"force-app"}]}')],
    ['force-app/main/default/classes/Hello.cls', Buffer.from('public class Hello {}')],
  ]);
  return {
    async listTree() { return [...files].map(([file, content]) => ({ path: file, objectId: file, mode: '100644', type: 'blob', size: content.length })); },
    async readBlob(id) { return files.get(id)!; },
  };
}

function repositoryInfo(provider: GitProviderId): GitRepositoryInfo {
  const address = normalizeRepository(provider === 'gitlab' ? 'group/project' : 'owner/project', provider);
  return { ...address, repositoryId: provider === 'bitbucket' ? '{repo-uuid}' : '123', private: true, defaultBranch: 'main' };
}
function tokenText(token: string | ApiCredential | undefined): string {
  return token === undefined ? '' : typeof token === 'string' ? token : token.scheme === 'bearer' ? token.token : `${token.username}:${token.password}`;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const providerId = options.provider ?? 'gitlab';
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-import-private-'));
  roots.push(root);
  const store = await openSqliteStore({ databasePath: path.join(root, 'sfud.db') });
  stores.push(store);
  const users = new UserRepository(store.database);
  const owner = await users.create({ email: 'private-owner@example.com', displayName: 'Private owner', role: 'ADMIN' });
  const other = await users.create({ email: 'private-other@example.com', displayName: 'Private other', role: 'ADMIN' });
  const vault = new TokenVault(new Map([[1, Buffer.alloc(32, 7)]]), 1);
  const connections = new GitConnectionRepository(store.database, vault);
  const address = normalizeRepository(providerId === 'gitlab' ? 'group/project' : 'owner/project', providerId);
  const connection = await connections.save({
    ownerUserId: owner.id, provider: providerId, providerHost: address.host, providerAccountId: 'provider-account',
    displayName: 'Private provider account', grantedPermissions: [],
    ...(options.repositoryPath === undefined ? {} : { repositoryPath: options.repositoryPath }),
    tokens: { accessToken: 'old-api-token', ...(options.apiUsername === undefined ? {} : { apiUsername: options.apiUsername }), ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }) },
  });
  const providerCalls = { inspect: [] as string[], refs: [] as string[], commits: [] as string[] };
  const info = repositoryInfo(providerId);
  const provider: GitProvider = {
    id: providerId,
    inspect: vi.fn(async (_address, token) => { providerCalls.inspect.push(tokenText(token)); return info; }),
    listRefs: vi.fn(async (_repository, _kind, _cursor, token) => { providerCalls.refs.push(tokenText(token)); return { refs: [{ kind: 'branch' as const, name: 'main', commitSha: sha }] }; }),
    resolveCommit: vi.fn(async (_repository, _ref, token) => { providerCalls.commits.push(tokenText(token)); return options.resolveCommit ?? sha; }),
  };
  let imported: GitImportService | undefined;
  const connectionService = new GitConnectionService(connections, async (ownerId, id) => { await imported?.cancelConnection(ownerId, id); });
  const remote = { lsRemote: vi.fn(async () => Buffer.from(
    `ref: refs/heads/main\tHEAD\n${options.remoteSha ?? sha}\trefs/heads/main\n`)) };
  const access = new GitRepositoryAccess(connections, connectionService, options.accessEnabled ?? true, remote);
  const history = new GitImportRepository(store.database);
  const projectRoot = path.join(root, 'projects');
  await mkdir(projectRoot, { recursive: true });
  const projects = new ManagedProjectService(projectRoot, 10 * 1024 * 1024, 50 * 1024 * 1024);
  const fetch = vi.fn(options.fetch ?? (async (input: GitFetchOptions) => { input.onDiskUsage(100); return objects(); }));
  imported = new GitImportService(history, projects, {
    providers: { github: provider, gitlab: provider, bitbucket: provider }, client: { fetch }, access,
    enabled: options.enabled ?? true, concurrency: options.concurrency ?? 2,
  });
  services.push(imported); projectStores.push(projects); roots.push(projectRoot);
  const request = { provider: providerId, repositoryPath: address.repositoryPath, ref: { kind: 'branch' as const, name: 'main' }, expectedCommitSha: sha, connectionId: connection.id };
  return { store, owner, other, connections, connection, connectionService, access, history, service: imported, provider, providerCalls, remote, fetch, address, request };
}

async function waitForStatus(f: Fixture, id: string, status: string) {
  await vi.waitFor(async () => expect((await f.history.get(id, f.owner.id)).status).toBe(status));
  return f.history.get(id, f.owner.id);
}

describe('private Git repository access and PAT import', { timeout: 60_000 }, () => {
  it('소유자와 provider를 확인하고 GitLab PAT의 API/Git credential을 분리한다', async () => {
    const f = await fixture();
    const authorization = await f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider);
    expect(f.providerCalls.inspect).toEqual(['old-api-token']);
    expect(authorization.apiCredential).toEqual({ scheme: 'bearer', token: 'old-api-token' });
    await expect(authorization.credentialProvider.getCredential()).resolves.toEqual({ username: 'oauth2', password: 'old-api-token' });
    await expect(f.access.authorize(f.other.id, f.connection.id, f.address, f.provider)).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(f.access.authorize(f.owner.id, f.connection.id, normalizeRepository('owner/project', 'bitbucket'), f.provider)).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    const disabled = await fixture({ accessEnabled: false });
    await expect(disabled.access.authorize(disabled.owner.id, disabled.connection.id, disabled.address, disabled.provider)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('repository-bound 연결은 REST provider를 건너뛰고 ls-remote/ref 검증/fetch 전체를 같은 경로로 수행한다', async () => {
    const f = await fixture({ repositoryPath: 'group/project' });
    const authorization = await f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider);
    expect(authorization.apiCredential).toBeUndefined();
    expect(authorization.repository.repositoryId).toMatch(/^git:/u);
    expect(f.providerCalls.inspect).toEqual([]);
    expect(f.remote.lsRemote).toHaveBeenCalledTimes(1);
    await expect(f.service.refs(f.request, 'branch', undefined, f.owner.id)).resolves.toEqual({
      refs: [{ kind: 'branch', name: 'main', commitSha: sha }],
    });
    const job = await f.service.create(f.owner.id, f.request);
    await waitForStatus(f, job.id, 'READY');
    expect(f.providerCalls.inspect).toEqual([]);
    expect(f.providerCalls.refs).toEqual([]);
    expect(f.providerCalls.commits).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.remote.lsRemote).toHaveBeenCalledTimes(3);
  });

  it('repository-bound 연결은 다른 소유자나 다른 저장소 경로로 재사용할 수 없다', async () => {
    const f = await fixture({ repositoryPath: 'group/project' });
    await expect(f.access.authorize(f.other.id, f.connection.id, f.address, f.provider))
      .rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(f.access.authorize(f.owner.id, f.connection.id, normalizeRepository('group/other', f.request.provider), f.provider))
      .rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
  });

  it('repository-bound ref가 이동하면 REST 호출 없이 fetch 전에 거절한다', async () => {
    const f = await fixture({ repositoryPath: 'group/project', remoteSha: changedSha });
    const job = await f.service.create(f.owner.id, f.request);
    expect((await waitForStatus(f, job.id, 'FAILED')).errorCode).toBe('REF_CHANGED');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.providerCalls.inspect).toEqual([]);
    expect(f.providerCalls.refs).toEqual([]);
    expect(f.providerCalls.commits).toEqual([]);
  });

  it('Bitbucket REST는 email+token Basic이고 Git transport는 전용 username을 사용한다', async () => {
    const f = await fixture({ provider: 'bitbucket', apiUsername: 'owner@example.com' });
    const authorization = await f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider);
    expect(authorization.apiCredential).toEqual({ scheme: 'basic', username: 'owner@example.com', password: 'old-api-token' });
    await expect(authorization.credentialProvider.getCredential()).resolves.toEqual({ username: 'x-bitbucket-api-token-auth', password: 'old-api-token' });
    await f.service.refs(f.request, 'branch', undefined, f.owner.id);
    expect(f.providerCalls.refs).toEqual(['owner@example.com:old-api-token']);
    const job = await f.service.create(f.owner.id, f.request);
    await waitForStatus(f, job.id, 'READY');
    expect(f.providerCalls.commits).toEqual(['owner@example.com:old-api-token']);
    expect(await f.fetch.mock.calls[0]?.[0].credentialProvider?.getCredential()).toEqual({ username: 'x-bitbucket-api-token-auth', password: 'old-api-token' });
  });

  it('만료된 PAT는 refresh 없이 재인증을 요구한다', async () => {
    const f = await fixture({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider)).rejects.toMatchObject({ code: 'GIT_REAUTH_REQUIRED' });
    await expect(f.connections.readCredentials(f.owner.id, f.connection.id)).rejects.toMatchObject({ code: 'GIT_REAUTH_REQUIRED' });
  });

  it('GitHub PAT는 installation 없이 x-access-token으로 transport한다', async () => {
    const f = await fixture({ provider: 'github' });
    const authorization = await f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider);
    expect(authorization.apiCredential).toEqual({ scheme: 'bearer', token: 'old-api-token' });
    await expect(authorization.credentialProvider.getCredential()).resolves.toEqual({ username: 'x-access-token', password: 'old-api-token' });
  });

  it('private 연결 없는 접근과 disabled import를 차단한다', async () => {
    const f = await fixture();
    await expect(f.service.inspect({ provider: f.request.provider, repositoryPath: f.request.repositoryPath })).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    const disabled = await fixture({ enabled: false });
    await expect(disabled.service.inspect({ provider: disabled.request.provider, repositoryPath: disabled.request.repositoryPath }, undefined, disabled.owner.id)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(disabled.service.create(disabled.owner.id, disabled.request)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(disabled.providerCalls.inspect).toEqual([]);
  });

  it('refs와 commit SHA를 재검증하고 SHA가 바뀌면 fetch 전에 실패한다', async () => {
    const f = await fixture({ resolveCommit: changedSha });
    await expect(f.service.inspect(f.request, undefined, f.owner.id)).resolves.toMatchObject({ private: true });
    await f.service.refs(f.request, 'tag', 'cursor-1', f.owner.id);
    const job = await f.service.create(f.owner.id, f.request);
    expect((await waitForStatus(f, job.id, 'FAILED')).errorCode).toBe('REF_CHANGED');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.providerCalls.inspect.every((token) => token === 'old-api-token')).toBe(true);
    expect(f.providerCalls.refs).toEqual(['old-api-token']);
    expect(f.providerCalls.commits).toEqual(['old-api-token']);
  });

  it('credential provider는 tokenVersion 변경 뒤 재사용되지 않는다', async () => {
    const f = await fixture();
    const authorization = await f.access.authorize(f.owner.id, f.connection.id, f.address, f.provider);
    await f.connections.save({ ownerUserId: f.owner.id, provider: f.request.provider, providerHost: f.address.host, providerAccountId: 'provider-account', displayName: 'Reconnected', grantedPermissions: [], tokens: { accessToken: 'reconnected-token' } });
    await expect(authorization.credentialProvider.getCredential()).rejects.toMatchObject({ code: 'GIT_REAUTH_REQUIRED' });
  });

  it('disconnect는 queued/running import를 취소하고 revoke/refresh를 호출하지 않는다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture({ concurrency: 1, fetch: async (input) => { input.onDiskUsage(100); await gate; return objects(); } });
    const first = await f.service.create(f.owner.id, f.request);
    const second = await f.service.create(f.owner.id, f.request);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    const disconnect = f.connectionService.disconnect(f.owner.id, f.connection.id);
    await vi.waitFor(async () => expect(await f.connections.list(f.owner.id)).toEqual([]));
    release(); await disconnect;
    expect((await f.history.get(first.id, f.owner.id)).status).toBe('CANCELLED');
    expect((await f.history.get(second.id, f.owner.id)).status).toBe('CANCELLED');
    expect(f.service.listSources(f.owner.id)).toEqual([]);
  });
});
