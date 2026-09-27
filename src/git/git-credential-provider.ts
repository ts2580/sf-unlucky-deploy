import type { GitFetchCredential } from './git-credential-bridge.js';
import type { GitTokens } from '../storage/git-connection-repository.js';
import type { GitProviderId } from './git-repository.js';
import { GitError } from './git-errors.js';

/** Git transport receives credentials, never provider/OAuth policy. */
export interface GitCredentialProvider {
  getCredential(): Promise<GitFetchCredential>;
}
export type ApiCredential = { scheme: 'bearer'; token: string }
  | { scheme: 'basic'; username: string; password: string };

export class GithubPatCredentialProvider implements GitCredentialProvider {
  public constructor(private readonly token: string) {}
  public async getCredential(): Promise<GitFetchCredential> { return { username: 'x-access-token', password: this.token }; }
}
export class GitlabPatCredentialProvider implements GitCredentialProvider {
  public constructor(private readonly token: string) {}
  public async getCredential(): Promise<GitFetchCredential> { return { username: 'oauth2', password: this.token }; }
}
export class BitbucketTokenCredentialProvider implements GitCredentialProvider {
  public constructor(private readonly token: string) {}
  public async getCredential(): Promise<GitFetchCredential> { return { username: 'x-bitbucket-api-token-auth', password: this.token }; }
}

export function credentialProviderFor(provider: GitProviderId, tokens: GitTokens): GitCredentialProvider {
  return provider === 'github' ? new GithubPatCredentialProvider(tokens.accessToken)
    : provider === 'gitlab' ? new GitlabPatCredentialProvider(tokens.accessToken)
      : new BitbucketTokenCredentialProvider(tokens.accessToken);
}

/** REST authentication is intentionally separate from Git HTTPS authentication. */
export function providerApiCredential(provider: GitProviderId, tokens: GitTokens): ApiCredential {
  if (provider !== 'bitbucket') return { scheme: 'bearer', token: tokens.accessToken };
  if (tokens.apiUsername === undefined || !validApiUsername(tokens.apiUsername)) throw new GitError('GIT_REAUTH_REQUIRED');
  return { scheme: 'basic', username: tokens.apiUsername, password: tokens.accessToken };
}
export function validApiUsername(value: string): boolean {
  return value.length <= 254 && !/[\u0000-\u001f\u007f]/u.test(value) && /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/u.test(value);
}
