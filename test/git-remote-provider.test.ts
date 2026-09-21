import { describe, expect, it, vi } from 'vitest';
import { GitError } from '../src/git/git-errors.js';
import { GitRemoteProvider, repositoryIdentity } from '../src/git/git-remote-provider.js';
import type { GitCredentialProvider } from '../src/git/git-credential-provider.js';
import { normalizeRepository } from '../src/git/git-repository.js';

const credential: GitCredentialProvider = {
  async getCredential() { return { username: 'x-access-token', password: 'fixture-secret' }; },
};
const address = normalizeRepository('https://github.com/acme/widget', 'github');
const sha = 'a'.repeat(40);
const tagSha = 'b'.repeat(40);

function provider(output: string | Buffer = Buffer.from('')) {
  const lsRemote = vi.fn(async () => Buffer.isBuffer(output) ? output : Buffer.from(output));
  return { provider: new GitRemoteProvider(address, credential, { lsRemote }), lsRemote };
}

describe('Git remote provider', () => {
  it('symref, branches, annotated peeled tags and stable repository identity를 해석한다', async () => {
    const f = provider([
      'ref: refs/heads/main\tHEAD',
      `${sha}\tHEAD`,
      `${sha}\trefs/heads/main`,
      `${tagSha}\trefs/tags/v1`,
      `${sha}\trefs/tags/v1^{} `,
    ].join('\n').replace('^{} ', '^{}') + '\n');
    const info = await f.provider.inspect(address);
    expect(info).toMatchObject({ ...address, repositoryId: repositoryIdentity(address), private: true, defaultBranch: 'main' });
    await expect(f.provider.listRefs(info, 'branch')).resolves.toEqual({ refs: [{ kind: 'branch', name: 'main', commitSha: sha }] });
    await expect(f.provider.listRefs(info, 'tag')).resolves.toEqual({ refs: [{ kind: 'tag', name: 'v1', commitSha: sha }] });
    expect(f.lsRemote).toHaveBeenCalledTimes(1);
  });

  it('태그에 peeled 값이 없으면 원래 tag object를 유지하고 30개 단위로 페이지를 낸다', async () => {
    const lines = Array.from({ length: 31 }, (_, i) => `${sha}\trefs/heads/branch-${String(i).padStart(2, '0')}`);
    lines.push(`${tagSha}\trefs/tags/v-object`);
    const f = provider(`${lines.join('\n')}\n`);
    const info = await f.provider.inspect(address);
    const first = await f.provider.listRefs(info, 'branch');
    expect(first.refs).toHaveLength(30);
    expect(first.nextCursor).toBe('2');
    await expect(f.provider.listRefs(info, 'branch', first.nextCursor)).resolves.toEqual({
      refs: [{ kind: 'branch', name: 'branch-30', commitSha: sha }],
    });
    await expect(f.provider.listRefs(info, 'tag')).resolves.toEqual({
      refs: [{ kind: 'tag', name: 'v-object', commitSha: tagSha }],
    });
  });

  it('빈 ls-remote 결과는 빈 ref 집합의 private 저장소로 처리한다', async () => {
    const f = provider(Buffer.alloc(0));
    const info = await f.provider.inspect(address);
    expect(info).toMatchObject({ private: true, repositoryId: repositoryIdentity(address) });
    await expect(f.provider.listRefs(info, 'branch')).resolves.toEqual({ refs: [] });
    await expect(f.provider.listRefs(info, 'tag')).resolves.toEqual({ refs: [] });
  });

  it('malformed, duplicate, orphan peeled and invalid page refs are rejected', async () => {
    for (const output of [
      'not-a-ref\n',
      `${sha}\trefs/heads/main\n${sha}\trefs/heads/main\n`,
      `${sha}\trefs/tags/orphan^{}\n`,
      `${sha}\trefs/tags/bad name\n`,
    ]) {
      const f = provider(output);
      await expect(f.provider.inspect(address)).rejects.toBeInstanceOf(GitError);
    }
    const f = provider(`${sha}\trefs/heads/main\n`);
    const info = await f.provider.inspect(address);
    for (const cursor of ['0', '01', '-1', '1000000', 'abc']) {
      await expect(f.provider.listRefs(info, 'branch', cursor)).rejects.toMatchObject({ code: 'INVALID_REF' });
    }
  });

  it('명시적 commit SHA는 형식만 검증하고 remote transport를 다시 부르지 않는다', async () => {
    const f = provider(`${sha}\trefs/heads/main\n`);
    const info = await f.provider.inspect(address);
    await expect(f.provider.resolveCommit(info, { kind: 'commit', name: sha })).resolves.toBe(sha);
    await expect(f.provider.resolveCommit(info, { kind: 'commit', name: 'not-a-sha' })).rejects.toMatchObject({ code: 'INVALID_REF' });
    expect(f.lsRemote).toHaveBeenCalledTimes(1);
  });

  it('다른 provider 또는 저장소 경로를 같은 연결으로 사용하지 못한다', async () => {
    const f = provider(`${sha}\trefs/heads/main\n`);
    await expect(f.provider.inspect(normalizeRepository('https://github.com/other/widget', 'github')))
      .rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(f.provider.inspect(normalizeRepository('https://gitlab.com/acme/widget', 'gitlab')))
      .rejects.toBeInstanceOf(GitError);
  });

  it('동일 인스턴스의 inspect/listRefs는 ls-remote 결과를 캐시한다', async () => {
    const f = provider(`${sha}\trefs/heads/main\n`);
    const info = await f.provider.inspect(address);
    await f.provider.listRefs(info, 'branch');
    await f.provider.resolveCommit(info, { kind: 'branch', name: 'main' });
    expect(f.lsRemote).toHaveBeenCalledTimes(1);
  });
});
