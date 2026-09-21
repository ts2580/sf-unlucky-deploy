import type { ApiCredential } from './git-credential-provider.js';
import type { GitRef, GitRepositoryAddress, GitProviderId } from './git-repository.js';

export interface GitRepositoryInfo extends GitRepositoryAddress {
  repositoryId: string;
  defaultBranch?: string;
  private: boolean;
}
export interface GitRefInfo extends GitRef { commitSha: string }
export interface GitRefPage { refs: GitRefInfo[]; nextCursor?: string }
export interface GitProvider {
  readonly id: GitProviderId;
  inspect(address: GitRepositoryAddress, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRepositoryInfo>;
  listRefs(repository: GitRepositoryInfo, kind: 'branch' | 'tag', cursor?: string, token?: string | ApiCredential, signal?: AbortSignal): Promise<GitRefPage>;
  resolveCommit(repository: GitRepositoryInfo, ref: GitRef, token?: string | ApiCredential, signal?: AbortSignal): Promise<string>;
}
