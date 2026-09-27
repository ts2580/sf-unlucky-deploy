import { describe, expect, it } from 'vitest';
import { normalizeRepository, validateGitRef } from '../src/git/git-repository.js';

describe('Git 저장소 주소와 ref', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'github', 'owner/repo'],
    ['https://gitlab.com/group/subgroup/프로젝트/', 'gitlab', 'group/subgroup/프로젝트'],
    ['https://bitbucket.org/workspace/repo', 'bitbucket', 'workspace/repo'],
  ] as const)('%s를 지원 제공자의 고정 HTTPS clone URL로 해석한다', (url, provider, repositoryPath) => {
    expect(normalizeRepository(url)).toMatchObject({ provider, repositoryPath });
    expect(normalizeRepository(repositoryPath, provider)).toEqual(normalizeRepository(url));
  });
  it.each([
    'file:///tmp/repo', 'ssh://git@github.com/owner/repo', 'git@github.com:owner/repo',
    'https://user:secret@github.com/owner/repo', 'https://127.0.0.1/owner/repo',
    'https://169.254.169.254/repo', 'https://github.com.evil.test/owner/repo',
    'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#main',
    'https://github.com:8443/owner/repo', 'https://github.com/owner/%2e%2e/repo',
    'https://github.com/owner%2frepo/extra', 'https://github.com/owner/repo/tree/main',
    'https://gitlab.com/owner/../repo', 'https://github.com/owner/repo%0a',
  ])('지원하지 않거나 위험한 주소 %s를 거절한다', (url) => {
    expect(() => normalizeRepository(url)).toThrow();
  });
  it('제공자 혼동과 옵션/ref 주입을 거절하고 slash/Unicode ref를 보존한다', () => {
    expect(() => normalizeRepository('https://github.com/owner/repo', 'gitlab')).toThrow();
    expect(validateGitRef({ kind: 'branch', name: 'release/한글' })).toEqual({ kind: 'branch', name: 'release/한글' });
    expect(validateGitRef({ kind: 'tag', name: 'v1.0.0' }).name).toBe('v1.0.0');
    expect(validateGitRef({ kind: 'commit', name: 'a'.repeat(40) }).name).toBe('a'.repeat(40));
    for (const name of ['--upload-pack=evil', 'refs/../main', 'main:target', 'main\n', '.hidden', 'a.lock', 'a//b', 'a@{1}', 'HEAD~1']) {
      expect(() => validateGitRef({ kind: 'branch', name })).toThrow();
    }
    expect(() => validateGitRef({ kind: 'commit', name: 'deadbeef' })).toThrow();
  });
});
