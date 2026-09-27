import { GitError } from './git-errors.js';

export type GitProviderId = 'github' | 'gitlab' | 'bitbucket';
export interface GitRepositoryAddress {
  provider: GitProviderId;
  host: string;
  repositoryPath: string;
  cloneUrl: string;
}
export interface GitRef { kind: 'branch' | 'tag' | 'commit'; name: string }

const hosts = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' } as const;

export function normalizeRepository(input: string, provider?: GitProviderId): GitRepositoryAddress {
  if (typeof input !== 'string' || input.length > 2048 || input !== input.trim()
    || /[\u0000-\u0020\u007f\\]/u.test(input)) throw new GitError('INVALID_REPOSITORY');
  const fullUrl = input.includes('://');
  if (!fullUrl && (provider === undefined || !Object.hasOwn(hosts, provider))) throw new GitError('INVALID_REPOSITORY');
  // Reject dot segments before WHATWG URL normalization can silently remove them.
  let decoded: string;
  try { decoded = decodeURIComponent(input); } catch { throw new GitError('INVALID_REPOSITORY'); }
  if (/(?:^|\/)(?:\.|\.\.)(?:\/|$)/u.test(decoded) || /%2f|%5c/iu.test(input)) throw new GitError('INVALID_REPOSITORY');
  let url: URL;
  try { url = new URL(fullUrl ? input : `https://${hosts[provider!]}/${input}`); }
  catch { throw new GitError('INVALID_REPOSITORY'); }
  const selected = (Object.keys(hosts) as GitProviderId[]).find((key) => hosts[key] === url.hostname);
  if (selected === undefined || (provider !== undefined && selected !== provider)
    || url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') throw new GitError('INVALID_REPOSITORY');
  const repositoryPath = decodeURIComponent(url.pathname).replace(/^\//u, '').replace(/\/$/u, '').replace(/\.git$/iu, '');
  const parts = repositoryPath.split('/');
  if (parts.length < 2 || (selected !== 'gitlab' && parts.length !== 2)
    || parts.some((part) => !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(part) || part.endsWith('.lock') || part.length > 255)) {
    throw new GitError('INVALID_REPOSITORY');
  }
  return {
    provider: selected, host: hosts[selected], repositoryPath,
    cloneUrl: `https://${hosts[selected]}/${parts.map(encodeURIComponent).join('/')}.git`,
  };
}

export function assertCommitSha(value: string): void {
  if (!/^[a-f0-9]{40}$/u.test(value)) throw new GitError('INVALID_REF');
}

export function validateGitRef(ref: GitRef): GitRef {
  if (ref.kind === 'commit') { assertCommitSha(ref.name); return ref; }
  if (!['branch', 'tag'].includes(ref.kind) || typeof ref.name !== 'string' || ref.name.length > 1024
    || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(ref.name) || ref.name.includes('..')
    || ref.name.includes('@{') || ref.name === '@' || ref.name.startsWith('-') || ref.name.endsWith('.')
    || ref.name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new GitError('INVALID_REF');
  }
  return ref;
}
