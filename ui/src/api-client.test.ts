import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientTimeoutError, apiRequest } from './api-client.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('UI API client', () => {
  it('자체 timeout을 사용자 취소와 구분된 오류로 반환한다', async () => {
    vi.useFakeTimers();
    stubBrowserWindow();
    stubAbortableFetch();

    const request = apiRequest('/slow', { timeoutMs: 30_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);

    const error = await request;
    expect(error).toEqual(expect.objectContaining({
      name: 'ApiClientTimeoutError',
      code: 'CLIENT_TIMEOUT',
      message: expect.stringContaining('서버에서 계속 처리될 수 있습니다'),
    }));
    expect(error).toBeInstanceOf(ApiClientTimeoutError);
  });

  it('호출자가 취소한 요청은 AbortError를 그대로 유지한다', async () => {
    stubBrowserWindow();
    stubAbortableFetch();
    const controller = new AbortController();

    const request = apiRequest('/cancelled', {
      signal: controller.signal,
      timeoutMs: 30_000,
    }).catch((error: unknown) => error);
    controller.abort();

    const error = await request;
    expect(error).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect(error).not.toBeInstanceOf(ApiClientTimeoutError);
  });
});

function stubBrowserWindow(): void {
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    dispatchEvent: vi.fn(),
  });
}

function stubAbortableFetch(): void {
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    })));
}
