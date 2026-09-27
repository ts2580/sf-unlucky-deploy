import type { ApiCredential } from '../git-credential-provider.js';
import { GitError } from '../git-errors.js';
import type { GitProvider, GitRefPage, GitRepositoryInfo } from '../git-provider.js';
import { normalizeRepository, validateGitRef, type GitRef, type GitRepositoryAddress } from '../git-repository.js';
import { arrayBody, commitSha, numberId, pageNumber, ProviderApi, record, stringField } from './provider-api.js';

export class GithubProvider implements GitProvider {
  public readonly id = 'github';
  public constructor(private readonly api = new ProviderApi()) {}

  public async inspect(address: GitRepositoryAddress, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRepositoryInfo> {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    const body = record((await this.api.get(this.endpoint(normalized), token, signal)).body);
    const canonical = normalizeRepository(stringField(body.full_name), this.id);
    if (typeof body.private !== 'boolean') throw new GitError('REPOSITORY_UNAVAILABLE');
    return { ...canonical, repositoryId: numberId(body.id), private: body.private,
      ...(typeof body.default_branch === 'string' && body.default_branch.length > 0 ? { defaultBranch: body.default_branch } : {}) };
  }

  public async listRefs(repository: GitRepositoryInfo, kind: 'branch' | 'tag', cursor?: string, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRefPage> {
    const page = pageNumber(cursor);
    const body = arrayBody((await this.api.get(`${this.endpoint(repository)}/${kind === 'branch' ? 'branches' : 'tags'}?per_page=30&page=${page}`, token, signal)).body);
    return { refs: body.map((value) => {
      const entry = record(value);
      const ref = validateGitRef({ kind, name: stringField(entry.name) });
      return { ...ref, commitSha: commitSha(record(entry.commit).sha) };
    }), ...(body.length === 30 ? { nextCursor: String(page + 1) } : {}) };
  }

  public async resolveCommit(repository: GitRepositoryInfo, selected: GitRef, token?: string | ApiCredential, signal?: AbortSignal): Promise<string> {
    const ref = validateGitRef(selected);
    const endpoint = this.endpoint(repository);
    if (ref.kind === 'commit') {
      const sha = commitSha(record((await this.api.get(`${endpoint}/commits/${ref.name}`, token, signal)).body).sha);
      if (sha !== ref.name) throw new GitError('REF_CHANGED');
      return sha;
    }
    const namespace = ref.kind === 'branch' ? 'heads' : 'tags';
    const body = record((await this.api.get(`${endpoint}/git/ref/${namespace}/${encodeURIComponent(ref.name)}`, token, signal)).body);
    if (body.ref !== `refs/${namespace}/${ref.name}`) throw new GitError('INVALID_REF');
    let object = record(body.object);
    for (let depth = 0; depth < 8; depth += 1) {
      const sha = commitSha(object.sha);
      if (object.type === 'commit') return sha;
      if (object.type !== 'tag' || ref.kind !== 'tag') throw new GitError('INVALID_REF');
      object = record(record((await this.api.get(`${endpoint}/git/tags/${sha}`, token, signal)).body).object);
    }
    throw new GitError('INVALID_REF');
  }

  private endpoint(address: GitRepositoryAddress): string {
    const normalized = normalizeRepository(address.cloneUrl, this.id);
    return `https://api.github.com/repos/${normalized.repositoryPath.split('/').map(encodeURIComponent).join('/')}`;
  }
}
