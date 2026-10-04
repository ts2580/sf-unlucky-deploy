import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { gitHostPolicyFromAddresses, gitHostPolicyFromEnvironment, resolveGitHost, SafeProviderHttpClient } from '../src/git/git-network.js';
import { GithubProvider } from '../src/git/providers/github-provider.js';
import { GitlabProvider } from '../src/git/providers/gitlab-provider.js';
import { BitbucketProvider } from '../src/git/providers/bitbucket-provider.js';
import { ProviderApi } from '../src/git/providers/provider-api.js';
import { normalizeRepository } from '../src/git/git-repository.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function mockResponse(status: number, payload: string, headers = {}) {
  vi.mocked(lookup).mockResolvedValue([{ address: '140.82.114.3', family: 4 }] as never);
  const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
  req.end = () => {
    queueMicrotask(() => {
      const callback = vi.mocked(request).mock.calls[0]![1] as (response: unknown) => void;
      const res = Object.assign(new EventEmitter(), { statusCode: status, headers });
      callback(res);
      res.emit('data', Buffer.from(payload));
      res.emit('end');
      req.emit('close');
    });
  };
  req.destroy = (error) => { req.emit('error', error); req.emit('close'); };
  vi.mocked(request).mockReturnValue(req as never);
}

describe('제공자 HTTP 접근 경계', () => {
  it.each([GithubProvider, GitlabProvider, BitbucketProvider])('클라우드 adapter는 셀프호스트를 공식 API로 재해석하지 않는다', async (Provider) => {
    const http = { request: vi.fn() };
    const provider = new Provider(new ProviderApi(http));
    const address = normalizeRepository('https://code.example.test:8443/context/team/project.git', provider.id);
    const repository = { ...address, repositoryId: '123', private: true };
    await expect(provider.inspect(address, 'fixture-token')).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(provider.listRefs(repository, 'branch', undefined, 'fixture-token')).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(provider.resolveCommit(repository, { kind: 'branch', name: 'main' }, 'fixture-token')).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    expect(http.request).not.toHaveBeenCalled();
  });
  it('DNS 응답 중 하나라도 사설 주소이면 연결 전에 거절한다', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '140.82.114.3', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(resolveGitHost('github.com')).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    expect(request).not.toHaveBeenCalled();
  });
  it('셀프호스팅 Git 주소도 공개 IP로만 해석한다', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    await expect(resolveGitHost('git.example.test')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });
  it('운영자가 명시한 사설 IP만 셀프호스팅 Git FQDN에 허용한다', async () => {
    const policy = gitHostPolicyFromAddresses(['192.168.10.25', 'fd00:1234::25']);
    vi.mocked(lookup).mockResolvedValue([{ address: '192.168.10.25', family: 4 }] as never);
    await expect(resolveGitHost('git.internal.example', policy)).resolves.toEqual({ address: '192.168.10.25', family: 4 });
    vi.mocked(lookup).mockResolvedValue([{ address: '192.168.10.25', family: 4 }, { address: '192.168.10.26', family: 4 }] as never);
    await expect(resolveGitHost('git.internal.example', policy)).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    expect(() => gitHostPolicyFromAddresses(['192.168.10.0/24'])).toThrow(/IPv4 또는 IPv6/u);
    expect(() => gitHostPolicyFromEnvironment({ SFUD_GIT_ALLOWED_IPS: 'git.internal.example' })).toThrow(/IPv4 또는 IPv6/u);
  });
  it('검증한 IP로 연결하면서 TLS servername과 Host를 고정한다', async () => {
    mockResponse(200, '{"id":123}');
    expect(await new SafeProviderHttpClient().request('https://api.github.com/repos/a/b', {
      headers: { authorization: 'Bearer fixture-secret' },
    })).toMatchObject({ status: 200, body: { id: 123 } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '140.82.114.3', servername: 'api.github.com', agent: false,
      headers: expect.objectContaining({ host: 'api.github.com' }),
    }), expect.any(Function));
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('리다이렉트에 credential을 전달하지 않고 provider 오류 본문을 외부 예외에 포함하지 않는다', async () => {
    mockResponse(302, '{}', { location: 'https://evil.test/token' });
    await expect(new SafeProviderHttpClient().request('https://api.github.com/repos/a/b', {
      headers: { authorization: 'Bearer fixture-secret' },
    })).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
    expect(request).toHaveBeenCalledTimes(1);
    vi.resetAllMocks();
    mockResponse(500, 'secret-provider-error-plaintext');
    await expect(new SafeProviderHttpClient().request('https://gitlab.com/api/v4/projects')).rejects.not.toThrow('secret-provider-error-plaintext');
  });
  it('응답 크기 제한과 사전 취소를 적용한다', async () => {
    mockResponse(200, JSON.stringify({ excessive: 'x'.repeat(2 * 1024 * 1024) }));
    await expect(new SafeProviderHttpClient().request('https://api.bitbucket.org/2.0/repositories')).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
    vi.resetAllMocks();
    await expect(new SafeProviderHttpClient().request('https://api.github.com/user', {
      signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' });
    expect(lookup).not.toHaveBeenCalled();
  });
});
