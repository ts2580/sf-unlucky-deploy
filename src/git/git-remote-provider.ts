import { createHash } from 'node:crypto';
import { GitClient, type GitRemoteOptions } from './git-client.js';
import type { GitCredentialProvider } from './git-credential-provider.js';
import { GitError } from './git-errors.js';
import type { GitProvider, GitRefPage, GitRepositoryInfo } from './git-provider.js';
import { assertCommitSha, normalizeRepository, validateGitRef, type GitRef, type GitRepositoryAddress } from './git-repository.js';

interface RemoteSnapshot { defaultBranch?: string; branches: Map<string, string>; tags: Map<string, string> }

/** A repository-bound connection needs only Git read access, not account/catalog APIs. */
export class GitRemoteProvider implements GitProvider {
  public readonly id;
  private snapshot: Promise<RemoteSnapshot> | undefined;
  public constructor(private readonly address: GitRepositoryAddress, private readonly credential: GitCredentialProvider,
    private readonly client: Pick<GitClient, 'lsRemote'> = new GitClient()) { this.id = address.provider; }

  public async inspect(address: GitRepositoryAddress, _token?: unknown, signal?: AbortSignal): Promise<GitRepositoryInfo> {
    this.assertAddress(address);
    const snapshot = await this.load(signal);
    // Git does not report visibility; require the bound connection conservatively.
    return { ...this.address, repositoryId: repositoryIdentity(this.address), private: true,
      ...(snapshot.defaultBranch === undefined ? {} : { defaultBranch: snapshot.defaultBranch }) };
  }

  public async listRefs(repository: GitRepositoryInfo, kind: 'branch' | 'tag', cursor?: string, _token?: unknown,
    signal?: AbortSignal): Promise<GitRefPage> {
    this.assertAddress(repository);
    if (cursor !== undefined && !/^[1-9]\d{0,5}$/u.test(cursor)) throw new GitError('INVALID_REF');
    const snapshot = await this.load(signal);
    const entries = [...(kind === 'branch' ? snapshot.branches : snapshot.tags)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const page = cursor === undefined ? 1 : Number(cursor);
    const offset = (page - 1) * 30;
    return { refs: entries.slice(offset, offset + 30).map(([name, commitSha]) => ({ kind, name, commitSha })),
      ...(offset + 30 < entries.length ? { nextCursor: String(page + 1) } : {}) };
  }

  public async resolveCommit(repository: GitRepositoryInfo, selected: GitRef, _token?: unknown, signal?: AbortSignal): Promise<string> {
    this.assertAddress(repository);
    const ref = validateGitRef(selected);
    // The fetch path validates that an explicitly supplied SHA actually names a commit.
    if (ref.kind === 'commit') { assertCommitSha(ref.name); return ref.name; }
    const snapshot = await this.load(signal);
    const sha = (ref.kind === 'branch' ? snapshot.branches : snapshot.tags).get(ref.name);
    if (sha === undefined) throw new GitError('INVALID_REF');
    return sha;
  }

  private assertAddress(address: GitRepositoryAddress) {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    if (normalized.repositoryPath !== this.address.repositoryPath || normalized.host !== this.address.host) {
      throw new GitError('GIT_CONNECTION_REQUIRED');
    }
  }

  private load(signal?: AbortSignal): Promise<RemoteSnapshot> {
    const options: GitRemoteOptions = { repository: this.address, credentialProvider: this.credential,
      ...(signal === undefined ? {} : { signal }) };
    this.snapshot ??= this.client.lsRemote(options).then(parseRefs);
    return this.snapshot;
  }
}

export function repositoryIdentity(address: GitRepositoryAddress): string {
  return `git:${createHash('sha256').update(`${address.host}/${address.repositoryPath}`).digest('hex')}`;
}

function parseRefs(output: Buffer): RemoteSnapshot {
  if (output.length > 4 * 1024 * 1024) throw new GitError('GIT_QUOTA_EXCEEDED');
  const snapshot: RemoteSnapshot = { branches: new Map(), tags: new Map() };
  const peeled = new Map<string, string>();
  for (const line of output.toString('utf8').split('\n').filter(Boolean)) {
    if (line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD')) {
      snapshot.defaultBranch = validateGitRef({ kind: 'branch', name: line.slice('ref: refs/heads/'.length, -'\tHEAD'.length) }).name;
      continue;
    }
    const match = /^([0-9a-f]{40})\t(HEAD|refs\/(?:heads|tags)\/.+)$/u.exec(line);
    if (match === null) throw new GitError('INVALID_GIT_OBJECT');
    const sha = match[1]!, fullName = match[2]!;
    if (fullName === 'HEAD') continue;
    const kind = fullName.startsWith('refs/heads/') ? 'branch' : 'tag';
    const isPeeled = kind === 'tag' && fullName.endsWith('^{}');
    const name = validateGitRef({ kind, name: fullName.slice(kind === 'branch' ? 11 : 10, isPeeled ? -3 : undefined) }).name;
    const target = isPeeled ? peeled : kind === 'branch' ? snapshot.branches : snapshot.tags;
    if (target.has(name)) throw new GitError('INVALID_GIT_OBJECT');
    target.set(name, sha);
  }
  for (const [name, sha] of peeled) {
    if (!snapshot.tags.has(name)) throw new GitError('INVALID_GIT_OBJECT');
    snapshot.tags.set(name, sha);
  }
  return snapshot;
}
