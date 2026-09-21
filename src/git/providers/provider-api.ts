import type { ApiCredential } from '../git-credential-provider.js';
import { GitError } from '../git-errors.js';
import { assertCommitSha } from '../git-repository.js';
import { SafeProviderHttpClient, type ProviderHttpClient, type ProviderHttpResponse, type ProviderHttpOptions } from '../git-network.js';

export class ProviderApi {
  public constructor(private readonly http: ProviderHttpClient = new SafeProviderHttpClient()) {}

  public async get(url: string, token?: string | ApiCredential, signal?: AbortSignal): Promise<ProviderHttpResponse> {
    return this.request(url, token, signal === undefined ? {} : { signal });
  }

  public async request(url: string, token?: string | ApiCredential, options: ProviderHttpOptions = {}): Promise<ProviderHttpResponse> {
    const response = await this.http.request(url, {
      ...options,
      headers: { ...options.headers, ...(token === undefined ? {} : { authorization: typeof token === 'string' ? `Bearer ${token}` : token.scheme === 'bearer' ? `Bearer ${token.token}` : `Basic ${Buffer.from(`${token.username}:${token.password}`).toString('base64')}` }) },
    });
    if (response.status === 429 || (response.status === 403 && (response.headers['x-ratelimit-remaining'] === '0'
      || response.headers['retry-after'] !== undefined))) {
      const error = new GitError('PROVIDER_RATE_LIMITED');
      const retry = response.headers['retry-after'];
      if (typeof retry === 'string') {
        const seconds = /^\d+$/u.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
        if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterSeconds = Math.min(seconds, 86400);
      }
      throw error;
    }
    if (response.status === 401 && token !== undefined) throw new GitError('GIT_REAUTH_REQUIRED');
    if (response.status === 403) throw new GitError('REPOSITORY_PERMISSION_DENIED');
    if (response.status < 200 || response.status >= 300) throw new GitError('REPOSITORY_UNAVAILABLE');
    return response;
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GitError('REPOSITORY_UNAVAILABLE');
  return value as Record<string, unknown>;
}
export function stringField(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitError('REPOSITORY_UNAVAILABLE');
  }
  return value;
}
export function numberId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new GitError('REPOSITORY_UNAVAILABLE');
  return String(value);
}
export function commitSha(value: unknown): string {
  const sha = stringField(value, 40);
  assertCommitSha(sha);
  return sha;
}
export function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9]\d{0,5}$/u.test(cursor)) throw new GitError('INVALID_REF');
  return Number(cursor);
}
export function arrayBody(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw new GitError('REPOSITORY_UNAVAILABLE');
  return value;
}
