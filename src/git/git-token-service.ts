import { GitError } from './git-errors.js';
import { normalizeRepository, type GitProviderId } from './git-repository.js';
import { credentialProviderFor, providerApiCredential, validApiUsername } from './git-credential-provider.js';
import { GitClient } from './git-client.js';
import { GitRemoteProvider } from './git-remote-provider.js';
import { ProviderApi, numberId, record, stringField } from './providers/provider-api.js';
import type { GitConnectionRepository, GitConnection, GitTokens } from '../storage/git-connection-repository.js';
import type { GitTokenInput } from '../api/git-contracts.js';

interface TokenUser { id: string; email: string; role: string }
export interface EnvironmentTokenResult { provider: GitProviderId; connection?: GitConnection; errorCode?: string }
const environmentKeys: Record<GitProviderId, string> = {
  github: 'SFUD_GITHUB_TOKEN', gitlab: 'SFUD_GITLAB_TOKEN', bitbucket: 'SFUD_BITBUCKET_TOKEN',
};

/** Both UI and environment credentials enter this validation and persistence path. */
export class GitTokenService {
  private readonly validating = new Set<string>();
  public constructor(private readonly connections: GitConnectionRepository, private readonly api = new ProviderApi(),
    private readonly enabled = true, private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly remote: Pick<GitClient, 'lsRemote'> = new GitClient()) {}

  public environmentAvailable(user: TokenUser): boolean {
    return this.enabled && user.role !== 'VIEWER'
      && this.environment.SFUD_GIT_TOKEN_OWNER_EMAIL?.trim().toLowerCase() === user.email.toLowerCase()
      && Object.values(environmentKeys).some((key) => Boolean(this.environment[key]));
  }

  public async importEnvironment(user: TokenUser): Promise<EnvironmentTokenResult[]> {
    if (!this.environmentAvailable(user)) throw new GitError('GIT_CONNECTION_REQUIRED');
    const results: EnvironmentTokenResult[] = [];
    for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
      const token = this.environment[environmentKeys[provider]];
      if (!token) continue;
      try {
        const repositoryPath = this.environment[`SFUD_${provider.toUpperCase()}_REPOSITORY`];
        const connection = await this.register(user.id, { provider, token,
          ...(repositoryPath === undefined || repositoryPath === '' ? {} : { repositoryPath }),
          ...(provider === 'bitbucket' && this.environment.SFUD_BITBUCKET_EMAIL !== undefined
            ? { apiUsername: this.environment.SFUD_BITBUCKET_EMAIL } : {}) });
        results.push({ provider, connection });
      } catch (error) {
        results.push({ provider, errorCode: error instanceof GitError ? error.code : 'GIT_REAUTH_REQUIRED' });
      }
    }
    return results;
  }

  public async register(owner: string, input: GitTokenInput, replaceId?: string): Promise<GitConnection> {
    if (!this.enabled) throw new GitError('PROVIDER_NOT_CONFIGURED');
    this.connections.assertReady();
    if (this.validating.has(owner) || this.validating.size >= 20) throw new GitError('PROVIDER_RATE_LIMITED');
    this.validating.add(owner);
    try {
      // Never contact a provider for another user's connection id.
      const previous = replaceId === undefined ? undefined : await this.connections.replacementState(owner, replaceId);
      if (previous !== undefined && previous.connection.provider !== input.provider) throw new GitError('GIT_CONNECTION_REQUIRED');
      const tokens: GitTokens = { accessToken: input.token,
        ...(input.apiUsername === undefined ? {} : { apiUsername: input.apiUsername.trim() }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) };
      if (input.token.length === 0 || input.token.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(input.token)
        || (input.provider === 'bitbucket' && input.repositoryPath === undefined && tokens.apiUsername === undefined)
        || (tokens.apiUsername !== undefined && !validApiUsername(tokens.apiUsername))
        || (input.provider !== 'bitbucket' && tokens.apiUsername !== undefined)
        || (tokens.expiresAt !== undefined && (!Number.isFinite(Date.parse(tokens.expiresAt))
          || new Date(tokens.expiresAt).toISOString() !== tokens.expiresAt || Date.parse(tokens.expiresAt) <= Date.now()))) {
        throw new GitError('GIT_REAUTH_REQUIRED');
      }
      if (input.repositoryPath !== undefined) {
        const address = normalizeRepository(input.repositoryPath, input.provider);
        if (previous !== undefined && previous.connection.repositoryPath !== address.repositoryPath) throw new GitError('GIT_CONNECTION_REQUIRED');
        const provider = new GitRemoteProvider(address, credentialProviderFor(input.provider, tokens), this.remote);
        const repository = await provider.inspect(address, undefined, AbortSignal.timeout(20_000));
        return await this.connections.save({ ownerUserId: owner, provider: input.provider, providerHost: address.host,
          providerAccountId: repository.repositoryId, displayName: address.repositoryPath.slice(0, 200),
          repositoryPath: address.repositoryPath, grantedPermissions: [], tokens },
        previous === undefined ? undefined : { id: replaceId!, tokenVersion: previous.tokenVersion });
      }
      if (previous?.connection.repositoryPath !== undefined) throw new GitError('GIT_CONNECTION_REQUIRED');
      const credential = providerApiCredential(input.provider, tokens);
      const endpoint = { github: 'https://api.github.com/user', gitlab: 'https://gitlab.com/api/v4/user',
        bitbucket: 'https://api.bitbucket.org/2.0/user' }[input.provider];
      const response = await this.api.get(endpoint, credential, AbortSignal.timeout(15_000)).catch((error: unknown) => {
        if (error instanceof GitError && error.code === 'REPOSITORY_PERMISSION_DENIED') {
          const codes = { github: 'GITHUB_ACCOUNT_PERMISSION_DENIED', gitlab: 'GITLAB_ACCOUNT_PERMISSION_DENIED',
            bitbucket: 'BITBUCKET_ACCOUNT_PERMISSION_DENIED' } as const;
          throw new GitError(codes[input.provider]);
        }
        if (error instanceof GitError && error.code === 'REPOSITORY_UNAVAILABLE') throw new GitError('GIT_ACCOUNT_UNAVAILABLE');
        throw error;
      });
      const account = record(response.body);
      const providerAccountId = input.provider === 'bitbucket' ? stringField(account.uuid, 100) : numberId(account.id);
      const displayName = stringField(input.provider === 'github' ? account.login
        : input.provider === 'gitlab' ? account.username : account.display_name, 200);
      if (previous !== undefined && previous.connection.providerAccountId !== providerAccountId) throw new GitError('GIT_CONNECTION_REQUIRED');
      const reportedExpiration = response.headers['github-authentication-token-expiration'];
      if (typeof reportedExpiration === 'string' && Number.isFinite(Date.parse(reportedExpiration))) {
        const timestamp = Date.parse(reportedExpiration);
        if (timestamp <= Date.now()) throw new GitError('GIT_REAUTH_REQUIRED');
        if (tokens.expiresAt === undefined || timestamp < Date.parse(tokens.expiresAt)) tokens.expiresAt = new Date(timestamp).toISOString();
      }
      // Empty means unreported, never claim that a supplied PAT is read-only.
      const scopes = response.headers['x-oauth-scopes'];
      const grantedPermissions = typeof scopes === 'string' ? scopes.split(',').map((scope) => scope.trim()).filter(Boolean) : [];
      return await this.connections.save({ ownerUserId: owner, provider: input.provider,
        providerHost: normalizeRepository('account/repository', input.provider).host, providerAccountId, displayName,
        grantedPermissions, tokens }, previous === undefined ? undefined : { id: replaceId!, tokenVersion: previous.tokenVersion });
    } catch (error) {
      if (error instanceof GitError) throw error;
      throw new GitError('GIT_REAUTH_REQUIRED');
    } finally { this.validating.delete(owner); }
  }
}
