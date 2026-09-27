import { providerApiCredential, type ApiCredential } from './git-credential-provider.js';
import type { GitConnectionRepository } from '../storage/git-connection-repository.js';
import type { GitConnectionService } from './git-connection-service.js';
import { GitError } from './git-errors.js';
import { normalizeRepository } from './git-repository.js';
import { validateProviderUrl } from './git-network.js';
import { arrayBody, numberId, pageNumber, ProviderApi, record, stringField } from './providers/provider-api.js';
import { repositoryIdentity } from './git-remote-provider.js';
import type { GitCatalogPage, GitCatalogQuery } from '../api/git-project-contracts.js';

/** Lists only the connected user's resources; every fetch authorizes again. */
export class GitRepositoryCatalog {
  public constructor(private readonly connections: GitConnectionRepository, private readonly credentials: GitConnectionService,
    private readonly enabled = true, private readonly api = new ProviderApi()) {}

  public async list(owner: string, id: string, query: GitCatalogQuery): Promise<GitCatalogPage> {
    const state = await this.credentials.credentials(owner, id);
    const provider = state.connection.provider;
    if (!this.enabled) throw new GitError('PROVIDER_NOT_CONFIGURED');
    if (state.connection.repositoryPath !== undefined) {
      if (query.namespace !== undefined || query.cursor !== undefined) throw new GitError('INVALID_REPOSITORY');
      const address = normalizeRepository(state.connection.repositoryPath, provider);
      return { namespaces: [], repositories: query.search && !address.repositoryPath.toLowerCase().includes(query.search.trim().toLowerCase())
        ? [] : [{ repositoryId: repositoryIdentity(address), repositoryPath: address.repositoryPath }] };
    }
    const credential = providerApiCredential(provider, state.tokens);
    const search = query.search?.trim() ?? '';
    if (search.length > 200 || /[\u0000-\u001f\u007f]/u.test(search)) throw new GitError('INVALID_REPOSITORY');
    const result = provider === 'github' ? await this.github(credential, query)
      : provider === 'gitlab' ? await this.gitlab(credential, query, search)
        : await this.bitbucket(credential, query, search);
    // A disconnect/reconnect while listing must not expose the old account's result.
    const current = await this.connections.readCredentials(owner, id);
    if (current.tokenVersion !== state.tokenVersion) throw new GitError('GIT_REAUTH_REQUIRED');
    return provider === 'github' && search !== ''
      ? { ...result, repositories: result.repositories.filter((repository) => repository.repositoryPath.toLowerCase().includes(search.toLowerCase())) }
      : result;
  }

  private async github(token: ApiCredential, query: GitCatalogQuery): Promise<GitCatalogPage> {
    const page = pageNumber(query.cursor);
    if (query.namespace !== undefined) throw new GitError('INVALID_REPOSITORY');
    const values = arrayBody((await this.api.get(`https://api.github.com/user/repos?per_page=30&page=${page}&sort=full_name`, token)).body).map(record);
    return { namespaces: [], repositories: values.filter((entry) => entry.permissions === undefined || record(entry.permissions).pull === true)
      .map((entry) => ({ repositoryId: numberId(entry.id), repositoryPath: normalizeRepository(stringField(entry.full_name), 'github').repositoryPath })),
      ...(values.length === 30 ? { nextCursor: String(page + 1) } : {}) };
  }

  private async gitlab(token: ApiCredential, query: GitCatalogQuery, search: string): Promise<GitCatalogPage> {
    if (query.namespace !== undefined) throw new GitError('INVALID_REPOSITORY');
    const page = pageNumber(query.cursor);
    const parameters = new URLSearchParams({ membership: 'true', simple: 'true', per_page: '30', page: String(page), order_by: 'id', sort: 'asc' });
    if (search !== '') parameters.set('search', search);
    const response = await this.api.get(`https://gitlab.com/api/v4/projects?${parameters}`, token);
    const values = arrayBody(response.body).map(record);
    const next = response.headers['x-next-page'];
    return { namespaces: [], repositories: values.map((entry) => ({ repositoryId: numberId(entry.id),
      repositoryPath: normalizeRepository(stringField(entry.path_with_namespace), 'gitlab').repositoryPath })),
      ...(typeof next === 'string' && next !== '' ? { nextCursor: String(pageNumber(next)) } : {}) };
  }

  private async bitbucket(token: ApiCredential, query: GitCatalogQuery, search: string): Promise<GitCatalogPage> {
    const namespace = query.namespace;
    if (namespace !== undefined && !/^[A-Za-z0-9_-]{1,100}$/u.test(namespace)) throw new GitError('INVALID_REPOSITORY');
    const base = namespace === undefined ? 'https://api.bitbucket.org/2.0/user/workspaces'
      : `https://api.bitbucket.org/2.0/user/workspaces/${encodeURIComponent(namespace)}/permissions/repositories`;
    const parameters = new URLSearchParams({ pagelen: '30' });
    if (namespace !== undefined && search !== '') parameters.set('q', `repository.name~${JSON.stringify(search)}`);
    const expected = new URL(`${base}?${parameters}`);
    const requestUrl = query.cursor === undefined ? expected.href : bitbucketCursor(query.cursor, expected);
    const body = record((await this.api.get(requestUrl, token)).body);
    const values = arrayBody(body.values).map(record);
    const nextCursor = body.next === undefined ? undefined : bitbucketCursor(stringField(body.next, 4000), expected);
    return { namespaces: namespace === undefined ? values.map((entry) => {
      const workspace = record(entry.workspace);
      const id = stringField(workspace.slug, 100);
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(id)) throw new GitError('REPOSITORY_UNAVAILABLE');
      return { id, name: stringField(workspace.name, 200) };
    }) : [], repositories: namespace === undefined ? [] : values.filter((entry) => ['read', 'write', 'admin'].includes(String(entry.permission)))
      .map((entry) => { const repository = record(entry.repository); return { repositoryId: stringField(repository.uuid, 100),
        repositoryPath: normalizeRepository(stringField(repository.full_name), 'bitbucket').repositoryPath }; }),
    ...(nextCursor === undefined ? {} : { nextCursor }) };
  }
}

function bitbucketCursor(value: string, expected: URL): string {
  const url = validateProviderUrl(value, 'api.bitbucket.org');
  if (url.pathname !== expected.pathname || url.searchParams.get('pagelen') !== '30'
    || url.searchParams.get('q') !== expected.searchParams.get('q')
    || [...url.searchParams.keys()].some((key) => !['pagelen', 'page', 'q'].includes(key) || url.searchParams.getAll(key).length !== 1)
    || !/^[1-9]\d{0,5}$/u.test(url.searchParams.get('page') ?? '')) throw new GitError('INVALID_REF');
  return url.href;
}
