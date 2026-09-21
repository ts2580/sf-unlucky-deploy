import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { GitError } from './git-errors.js';

const hosts = new Set(['github.com', 'api.github.com', 'gitlab.com', 'bitbucket.org', 'api.bitbucket.org']);
const forbidden = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) forbidden.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  forbidden.addSubnet(network, prefix, 'ipv6');
}

export function isPublicGitAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !forbidden.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !forbidden.check(address, 'ipv6');
}

export function validateProviderUrl(value: string, expectedHost?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new GitError('INVALID_REPOSITORY'); }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || (expectedHost !== undefined && url.hostname !== expectedHost)
    || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== ''
    || /[\u0000-\u0020\u007f\\]/u.test(value)) throw new GitError('INVALID_REPOSITORY');
  return url;
}

export async function resolveGitHost(host: string): Promise<{ address: string; family: 4 | 6 }> {
  if (!hosts.has(host)) throw new GitError('INVALID_REPOSITORY');
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new GitError('REPOSITORY_UNAVAILABLE'); }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicGitAddress(entry.address))) throw new GitError('INVALID_REPOSITORY');
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export interface ProviderHttpResponse { status: number; headers: Record<string, string | string[] | undefined>; body: unknown }
export interface ProviderHttpOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface ProviderHttpClient {
  request(url: string, options?: ProviderHttpOptions): Promise<ProviderHttpResponse>;
}

export class SafeProviderHttpClient implements ProviderHttpClient {
  public async request(value: string, options: ProviderHttpOptions = {}): Promise<ProviderHttpResponse> {
    const url = validateProviderUrl(value);
    if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
    const selected = await resolveGitHost(url.hostname);
    if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
    return new Promise((resolve, reject) => {
      // Connect to the vetted address while retaining the original TLS servername
      // and Host. No second DNS lookup can rebind the request into an internal IP.
      const req = request({
        hostname: selected.address, family: selected.family, port: 443, path: `${url.pathname}${url.search}`,
        servername: url.hostname, method: options.method ?? 'GET', agent: false,
        headers: { ...options.headers, host: url.hostname, 'user-agent': 'sf-unlucky-deploy', accept: 'application/json' },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new GitError('GIT_QUOTA_EXCEEDED'));
          else chunks.push(chunk);
        });
        res.once('error', () => reject(new GitError('REPOSITORY_UNAVAILABLE')));
        res.once('end', () => {
          const status = res.statusCode ?? 502;
          // Deliberately do not follow provider-controlled redirects with credentials.
          if (status >= 300 && status < 400) { reject(new GitError('REPOSITORY_UNAVAILABLE')); return; }
          let body: unknown = null;
          try { if (bytes > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { reject(new GitError('REPOSITORY_UNAVAILABLE')); return; }
          resolve({ status, headers: res.headers, body });
        });
      });
      const timeout = setTimeout(() => req.destroy(new GitError('IMPORT_TIMEOUT')), 30_000);
      timeout.unref();
      req.once('close', () => clearTimeout(timeout));
      req.once('error', (error) => reject(error instanceof GitError ? error : new GitError(
        options.signal?.aborted ? 'IMPORT_CANCELLED' : 'REPOSITORY_UNAVAILABLE',
      )));
      req.end(options.body);
    });
  }
}
