import type { ApiCredential } from '../git-credential-provider.js';
import { GitError } from '../git-errors.js';
import type { GitProvider, GitRefPage, GitRepositoryInfo } from '../git-provider.js';
import { validateProviderUrl } from '../git-network.js';
import { normalizeRepository, validateGitRef, type GitRef, type GitRepositoryAddress } from '../git-repository.js';
import { arrayBody, commitSha, ProviderApi, record, stringField } from './provider-api.js';

export class BitbucketProvider implements GitProvider {
  public readonly id = 'bitbucket';
  public constructor(private readonly api = new ProviderApi()) {}

  public async inspect(address: GitRepositoryAddress, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRepositoryInfo> {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    const body = record((await this.api.get(this.endpoint(normalized), token, signal)).body);
    const canonical = normalizeRepository(stringField(body.full_name), this.id);
    if (typeof body.is_private !== 'boolean') throw new GitError('REPOSITORY_UNAVAILABLE');
    const branch = body.mainbranch === null || body.mainbranch === undefined ? undefined : stringField(record(body.mainbranch).name);
    return { ...canonical, repositoryId: stringField(body.uuid, 100), private: body.is_private,
      ...(branch === undefined ? {} : { defaultBranch: branch }) };
  }

  public async listRefs(repository: GitRepositoryInfo, kind: 'branch' | 'tag', cursor?: string, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRefPage> {
    const base = `${this.endpoint(repository)}/refs/${kind === 'branch' ? 'branches' : 'tags'}?pagelen=30`;
    const url = cursor === undefined ? base : paginationUrl(base, cursor);
    const body = record((await this.api.get(url, token, signal)).body);
    return { refs: arrayBody(body.values).map((value) => {
      const entry = record(value);
      return { ...validateGitRef({ kind, name: stringField(entry.name) }), commitSha: commitSha(record(entry.target).hash) };
    }), ...(body.next === undefined ? {} : { nextCursor: paginationUrl(base, stringField(body.next, 4096)) }) };
  }

  public async resolveCommit(repository: GitRepositoryInfo, selected: GitRef, token?: string | ApiCredential, signal?: AbortSignal): Promise<string> {
    const ref = validateGitRef(selected);
    const type = ref.kind === 'branch' ? 'refs/branches' : ref.kind === 'tag' ? 'refs/tags' : 'commit';
    const body = record((await this.api.get(`${this.endpoint(repository)}/${type}/${encodeURIComponent(ref.name)}`, token, signal)).body);
    const sha = commitSha(ref.kind === 'commit' ? body.hash : record(body.target).hash);
    if (ref.kind === 'commit' && sha !== ref.name) throw new GitError('REF_CHANGED');
    if (ref.kind !== 'commit' && body.name !== ref.name) throw new GitError('INVALID_REF');
    return sha;
  }

  private endpoint(address: GitRepositoryAddress): string {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    return `https://api.bitbucket.org/2.0/repositories/${normalized.repositoryPath.split('/').map(encodeURIComponent).join('/')}`;
  }
}

function paginationUrl(base: string, cursor: string): string {
  const url = validateProviderUrl(cursor, 'api.bitbucket.org');
  const expected = new URL(base);
  if (url.pathname !== expected.pathname || url.searchParams.get('pagelen') !== '30'
    || [...url.searchParams.keys()].some((key) => !['pagelen', 'page', 'after'].includes(key))
    || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) throw new GitError('INVALID_REF');
  if (url.searchParams.has('page') && !/^[1-9]\d{0,5}$/u.test(url.searchParams.get('page')!)) throw new GitError('INVALID_REF');
  if ((url.searchParams.get('after')?.length ?? 0) > 1024) throw new GitError('INVALID_REF');
  return url.href;
}
