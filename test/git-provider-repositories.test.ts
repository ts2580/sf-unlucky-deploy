import { describe, expect, it, vi } from 'vitest';
import { GithubProvider } from '../src/git/providers/github-provider.js';
import { GitlabProvider } from '../src/git/providers/gitlab-provider.js';
import { BitbucketProvider } from '../src/git/providers/bitbucket-provider.js';
import { ProviderApi } from '../src/git/providers/provider-api.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import type { ProviderHttpClient, ProviderHttpResponse } from '../src/git/git-network.js';

const sha = 'a'.repeat(40), tagSha = 'b'.repeat(40);
function fixture(responses: ProviderHttpResponse[]) {
  const request = vi.fn<ProviderHttpClient['request']>(async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error('Unexpected provider request');
    return response;
  });
  return { api: new ProviderApi({ request }), request };
}
function ok(body: unknown, headers = {}): ProviderHttpResponse { return { status: 200, body, headers }; }

describe('Git 제공자 저장소·ref API', () => {
  it('GitHub 정식 저장소 식별, slash branch, annotated tag의 commit을 해석한다', async () => {
    const f = fixture([
      ok({ id: 123, full_name: 'owner/project', private: false, default_branch: 'release/main', clone_url: 'https://evil.test/ignore' }),
      ok({ ref: 'refs/heads/release/한글', object: { type: 'commit', sha } }),
      ok({ ref: 'refs/tags/v1', object: { type: 'tag', sha: tagSha } }),
      ok({ object: { type: 'commit', sha } }),
      ok({ sha }),
      ok([{ name: 'release/main', commit: { sha } }]),
    ]);
    const provider = new GithubProvider(f.api);
    const repository = await provider.inspect(normalizeRepository('https://github.com/owner/project'));
    expect(repository).toMatchObject({ repositoryId: '123', defaultBranch: 'release/main', cloneUrl: 'https://github.com/owner/project.git' });
    expect(await provider.resolveCommit(repository, { kind: 'branch', name: 'release/한글' })).toBe(sha);
    expect(f.request.mock.calls[1]?.[0]).toContain('/git/ref/heads/release%2F%ED%95%9C%EA%B8%80');
    expect(await provider.resolveCommit(repository, { kind: 'tag', name: 'v1' })).toBe(sha);
    expect(await provider.resolveCommit(repository, { kind: 'commit', name: sha })).toBe(sha);
    expect(await provider.listRefs(repository, 'branch')).toEqual({ refs: [{ kind: 'branch', name: 'release/main', commitSha: sha }] });
  });

  it('GitHub 비슷한 이름 ref를 정확히 일치한 ref로 잘못 취급하지 않는다', async () => {
    const f = fixture([ok({ ref: 'refs/heads/main-extra', object: { type: 'commit', sha } })]);
    const repo = { ...normalizeRepository('https://github.com/owner/repo'), repositoryId: '1', private: true };
    await expect(new GithubProvider(f.api).resolveCommit(repo, { kind: 'branch', name: 'main' })).rejects.toMatchObject({ code: 'INVALID_REF' });
  });

  it('GitLab subgroup와 기본 branch·태그·페이지네이션을 provider ID 기준으로 처리한다', async () => {
    const f = fixture([
      ok({ id: 42, path_with_namespace: 'group/sub/project', visibility: 'private', default_branch: 'develop' }),
      ok([{ name: 'release/v1', commit: { id: sha } }], { 'x-next-page': '2' }),
      ok({ name: 'release/v1', commit: { id: sha } }),
      ok({ id: sha }),
    ]);
    const provider = new GitlabProvider(f.api);
    const repo = await provider.inspect(normalizeRepository('https://gitlab.com/group/sub/project'), 'fixture-token');
    expect(f.request.mock.calls[0]?.[0]).toContain('projects/group%2Fsub%2Fproject');
    expect(repo).toMatchObject({ repositoryId: '42', defaultBranch: 'develop', private: true });
    expect(await provider.listRefs(repo, 'tag', undefined, 'fixture-token')).toEqual({
      refs: [{ kind: 'tag', name: 'release/v1', commitSha: sha }], nextCursor: '2',
    });
    expect(f.request.mock.calls[1]?.[0]).toContain('/projects/42/repository/tags');
    expect(await provider.resolveCommit(repo, { kind: 'tag', name: 'release/v1' }, 'fixture-token')).toBe(sha);
    expect(await provider.resolveCommit(repo, { kind: 'commit', name: sha }, 'fixture-token')).toBe(sha);
    expect(f.request.mock.calls.every(([, options]) => options?.headers?.authorization === 'Bearer fixture-token')).toBe(true);
  });

  it('Bitbucket workspace, mainbranch와 검증한 같은 endpoint의 페이지 URL만 사용한다', async () => {
    const base = 'https://api.bitbucket.org/2.0/repositories/workspace/project/refs/branches?pagelen=30';
    const f = fixture([
      ok({ uuid: '{repository-id}', full_name: 'workspace/project', is_private: true, mainbranch: { name: 'master' } }),
      ok({ values: [{ name: 'feature/한글', target: { hash: sha } }], next: `${base}&page=2` }),
      ok({ values: [] }),
      ok({ name: 'feature/한글', target: { hash: sha } }),
    ]);
    const provider = new BitbucketProvider(f.api);
    const repo = await provider.inspect(normalizeRepository('https://bitbucket.org/workspace/project'), 'fixture-token');
    expect(repo.defaultBranch).toBe('master');
    const first = await provider.listRefs(repo, 'branch', undefined, 'fixture-token');
    expect(first.nextCursor).toBe(`${base}&page=2`);
    expect(await provider.listRefs(repo, 'branch', first.nextCursor, 'fixture-token')).toEqual({ refs: [] });
    expect(await provider.resolveCommit(repo, { kind: 'branch', name: 'feature/한글' }, 'fixture-token')).toBe(sha);
    for (const cursor of [
      'https://evil.test/2.0/repositories/workspace/project/refs/branches?pagelen=30',
      'https://api.bitbucket.org/2.0/user?pagelen=30', `${base}&access_token=attacker`, `${base}&page=2&page=3`,
    ]) await expect(provider.listRefs(repo, 'branch', cursor, 'fixture-token')).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(4);
  });

  it('빈 저장소와 404는 private로 단정하지 않고 rate limit과 재로그인을 구분한다', async () => {
    const f = fixture([
      ok({ id: 1, path_with_namespace: 'group/empty', visibility: 'public', default_branch: null }),
      { status: 404, headers: {}, body: { error: 'untrusted secret' } },
      { status: 429, headers: { 'retry-after': '120' }, body: {} },
      { status: 401, headers: {}, body: {} },
      { status: 403, headers: {}, body: {} },
    ]);
    const provider = new GitlabProvider(f.api);
    const repo = await provider.inspect(normalizeRepository('https://gitlab.com/group/empty'));
    expect(repo.defaultBranch).toBeUndefined();
    expect(repo.private).toBe(false);
    await expect(provider.resolveCommit(repo, { kind: 'branch', name: 'main' })).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
    await expect(f.api.get('https://gitlab.com/api/v4/user', 'token')).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfterSeconds: 120 });
    await expect(f.api.get('https://gitlab.com/api/v4/user', 'token')).rejects.toMatchObject({ code: 'GIT_REAUTH_REQUIRED' });
    await expect(f.api.get('https://gitlab.com/api/v4/user', 'token')).rejects.toMatchObject({ code: 'REPOSITORY_PERMISSION_DENIED' });
  });
});
