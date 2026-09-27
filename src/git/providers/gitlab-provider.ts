import type { ApiCredential } from '../git-credential-provider.js';
import { GitError } from '../git-errors.js';
import type { GitProvider, GitRefPage, GitRepositoryInfo } from '../git-provider.js';
import { normalizeRepository, validateGitRef, type GitRef, type GitRepositoryAddress } from '../git-repository.js';
import { arrayBody, commitSha, numberId, pageNumber, ProviderApi, record, stringField } from './provider-api.js';

export class GitlabProvider implements GitProvider {
  public readonly id = 'gitlab';
  public constructor(private readonly api = new ProviderApi()) {}

  public async inspect(address: GitRepositoryAddress, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRepositoryInfo> {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    const body = record((await this.api.get(`https://gitlab.com/api/v4/projects/${encodeURIComponent(normalized.repositoryPath)}`, token, signal)).body);
    const canonical = normalizeRepository(stringField(body.path_with_namespace), this.id);
    if (!['public', 'internal', 'private'].includes(String(body.visibility))) throw new GitError('REPOSITORY_UNAVAILABLE');
    return { ...canonical, repositoryId: numberId(body.id), private: body.visibility !== 'public',
      ...(typeof body.default_branch === 'string' && body.default_branch.length > 0 ? { defaultBranch: body.default_branch } : {}) };
  }

  public async listRefs(repository: GitRepositoryInfo, kind: 'branch' | 'tag', cursor?: string, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRefPage> {
    const page = pageNumber(cursor);
    const result = await this.api.get(`${this.endpoint(repository)}/${kind === 'branch' ? 'branches' : 'tags'}?per_page=30&page=${page}`, token, signal);
    const body = arrayBody(result.body);
    const next = result.headers['x-next-page'];
    const nextPage = typeof next === 'string' && next !== '' ? String(pageNumber(next)) : undefined;
    return { refs: body.map((value) => {
      const entry = record(value);
      return { ...validateGitRef({ kind, name: stringField(entry.name) }), commitSha: commitSha(record(entry.commit).id) };
    }), ...(nextPage === undefined ? {} : { nextCursor: nextPage }) };
  }

  public async resolveCommit(repository: GitRepositoryInfo, selected: GitRef, token?: string | ApiCredential, signal?: AbortSignal): Promise<string> {
    const ref = validateGitRef(selected);
    const type = ref.kind === 'branch' ? 'branches' : ref.kind === 'tag' ? 'tags' : 'commits';
    const body = record((await this.api.get(`${this.endpoint(repository)}/${type}/${encodeURIComponent(ref.name)}`, token, signal)).body);
    const sha = commitSha(ref.kind === 'commit' ? body.id : record(body.commit).id);
    if (ref.kind === 'commit' && sha !== ref.name) throw new GitError('REF_CHANGED');
    if (ref.kind !== 'commit' && body.name !== ref.name) throw new GitError('INVALID_REF');
    return sha;
  }

  private endpoint(repository: GitRepositoryInfo): string {
    normalizeRepository(repository.cloneUrl, this.id);
    if (!/^[1-9]\d*$/u.test(repository.repositoryId)) throw new GitError('INVALID_REPOSITORY');
    return `https://gitlab.com/api/v4/projects/${repository.repositoryId}/repository`;
  }
}
