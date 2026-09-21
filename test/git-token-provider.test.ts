import { describe, expect, it } from 'vitest';

import {
  BitbucketTokenCredentialProvider,
  GithubPatCredentialProvider,
  GitlabPatCredentialProvider,
  credentialProviderFor,
  providerApiCredential,
  validApiUsername,
} from '../src/git/git-credential-provider.js';
import { GitError } from '../src/git/git-errors.js';

describe('PAT/API token credential provider', () => {
  it.each([
    { provider: new GithubPatCredentialProvider('github-pat'), expected: { username: 'x-access-token', password: 'github-pat' } },
    { provider: new GitlabPatCredentialProvider('gitlab-pat'), expected: { username: 'oauth2', password: 'gitlab-pat' } },
    { provider: new BitbucketTokenCredentialProvider('bitbucket-token'), expected: { username: 'x-bitbucket-api-token-auth', password: 'bitbucket-token' } },
  ])('Git HTTPS credential은 provider별 username과 PAT를 사용한다', async ({ provider, expected }) => {
    await expect(provider.getCredential()).resolves.toEqual(expected);
  });

  it('credentialProviderFor는 API provider별 Git transport credential provider를 선택한다', async () => {
    await expect(credentialProviderFor('github', { accessToken: 'gh-pat' }).getCredential())
      .resolves.toEqual({ username: 'x-access-token', password: 'gh-pat' });
    await expect(credentialProviderFor('gitlab', { accessToken: 'gl-pat' }).getCredential())
      .resolves.toEqual({ username: 'oauth2', password: 'gl-pat' });
    await expect(credentialProviderFor('bitbucket', { accessToken: 'bb-token' }).getCredential())
      .resolves.toEqual({ username: 'x-bitbucket-api-token-auth', password: 'bb-token' });
  });

  it('GitHub/GitLab REST는 bearer, Bitbucket REST는 email+token Basic을 사용한다', () => {
    expect(providerApiCredential('github', { accessToken: 'gh-pat' })).toEqual({ scheme: 'bearer', token: 'gh-pat' });
    expect(providerApiCredential('gitlab', { accessToken: 'gl-pat' })).toEqual({ scheme: 'bearer', token: 'gl-pat' });
    expect(providerApiCredential('bitbucket', { accessToken: 'bb-token', apiUsername: 'owner@example.com' })).toEqual({
      scheme: 'basic', username: 'owner@example.com', password: 'bb-token',
    });
  });

  it.each([undefined, '', 'owner', 'owner@example', 'owner @example.com', 'owner@example.com:secret'])('Bitbucket API username이 없거나 잘못되면 재인증을 요구한다', (apiUsername) => {
    expect(() => providerApiCredential('bitbucket', { accessToken: 'bb-token', ...(apiUsername === undefined ? {} : { apiUsername }) }))
      .toThrowError(new GitError('GIT_REAUTH_REQUIRED'));
  });

  it('API username 검증은 일반 email을 허용하고 공백·인증정보 삽입을 거부한다', () => {
    expect(validApiUsername('owner@example.com')).toBe(true);
    expect(validApiUsername('owner+git@example.co.uk')).toBe(true);
    expect(validApiUsername('owner@example.com\nAuthorization: Bearer leaked')).toBe(false);
    expect(validApiUsername('owner@example.com:password')).toBe(false);
  });
});
