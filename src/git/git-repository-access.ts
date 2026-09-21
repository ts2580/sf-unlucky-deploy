import type { GitConnectionRepository } from '../storage/git-connection-repository.js';
import type { GitConnectionService } from './git-connection-service.js';
import { credentialProviderFor, providerApiCredential, type ApiCredential, type GitCredentialProvider } from './git-credential-provider.js';
import { GitError } from './git-errors.js';
import type { GitProvider, GitRepositoryInfo } from './git-provider.js';
import type { GitRepositoryAddress } from './git-repository.js';
import { GitRemoteProvider } from './git-remote-provider.js';
import { GitClient } from './git-client.js';

export interface GitRepositoryAuthorization {
  repository: GitRepositoryInfo;
  apiCredential?: ApiCredential;
  provider?: GitProvider;
  credentialProvider: GitCredentialProvider;
  assertCurrent(): Promise<void>;
}

export class GitRepositoryAccess {
  public constructor(private readonly connections: GitConnectionRepository, private readonly credentials: GitConnectionService,
    private readonly enabled = true, private readonly remote: Pick<GitClient, 'lsRemote'> = new GitClient()) {}

  public async validate(owner: string, id: string, address: GitRepositoryAddress) {
    if (!this.enabled) throw new GitError('PROVIDER_NOT_CONFIGURED');
    const state = await this.credentials.credentials(owner, id);
    if (state.connection.provider !== address.provider || state.connection.providerHost !== address.host
      || (state.connection.repositoryPath !== undefined && state.connection.repositoryPath !== address.repositoryPath)) {
      throw new GitError('GIT_CONNECTION_REQUIRED');
    }
    return state;
  }

  public async authorize(owner: string, id: string, address: GitRepositoryAddress, provider: GitProvider,
    signal?: AbortSignal): Promise<GitRepositoryAuthorization> {
    const state = await this.validate(owner, id, address);
    const assertCurrent = async () => {
      if (signal?.aborted) throw new GitError('IMPORT_CANCELLED');
      const current = await this.credentials.credentials(owner, id);
      if (current.tokenVersion !== state.tokenVersion) throw new GitError('GIT_REAUTH_REQUIRED');
    };
    const source = credentialProviderFor(address.provider, state.tokens);
    const credentialProvider: GitCredentialProvider = {
      async getCredential() { await assertCurrent(); return source.getCredential(); },
    };
    const selectedProvider = state.connection.repositoryPath === undefined ? provider : new GitRemoteProvider(address, credentialProvider, this.remote);
    const apiCredential = state.connection.repositoryPath === undefined ? providerApiCredential(address.provider, state.tokens) : undefined;
    let repository: GitRepositoryInfo;
    try { repository = await selectedProvider.inspect(address, apiCredential, signal); }
    catch (error) {
      if (error instanceof GitError && error.code === 'GIT_REAUTH_REQUIRED') {
        await this.connections.requireReauthentication(owner, id, state.tokenVersion);
      }
      throw error;
    }
    await assertCurrent();
    return { repository, ...(apiCredential === undefined ? {} : { apiCredential }), provider: selectedProvider,
      assertCurrent, credentialProvider };
  }
}
