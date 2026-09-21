import { GitError } from './git-errors.js';
import { GitConnectionRepository } from '../storage/git-connection-repository.js';

/** PATs are user-issued: expiry requires replacement, never an OAuth refresh. */
export class GitConnectionService {
  public constructor(private readonly connections: GitConnectionRepository,
    private readonly onDisconnect?: (owner: string, id: string) => Promise<void>) {}

  public async credentials(ownerUserId: string, id: string) {
    const state = await this.connections.readCredentials(ownerUserId, id);
    if (state.tokens.expiresAt !== undefined && Date.parse(state.tokens.expiresAt) <= Date.now()) {
      await this.connections.requireReauthentication(ownerUserId, id, state.tokenVersion);
      throw new GitError('GIT_REAUTH_REQUIRED');
    }
    return state;
  }

  public async disconnect(ownerUserId: string, id: string): Promise<void> {
    await this.connections.disconnect(ownerUserId, id);
    await this.onDisconnect?.(ownerUserId, id);
  }
}
