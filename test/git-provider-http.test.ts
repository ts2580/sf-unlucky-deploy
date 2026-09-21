import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { resolveGitHost, SafeProviderHttpClient } from '../src/git/git-network.js';

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
  it('DNS 응답 중 하나라도 사설 주소이면 연결 전에 거절한다', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '140.82.114.3', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(resolveGitHost('github.com')).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    expect(request).not.toHaveBeenCalled();
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
