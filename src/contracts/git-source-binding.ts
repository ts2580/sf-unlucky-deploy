import type { GitProviderId } from './git-contracts.js';

export interface GitRef { kind: 'branch' | 'tag' | 'commit'; name: string }

export interface GitImportRequest {
  provider: GitProviderId;
  repositoryPath: string;
  ref: GitRef;
  expectedCommitSha: string;
  projectRoot?: string;
  metadataType?: string;
  connectionId?: string;
}

export interface GitRegistration {
  requiresRepositoryUrl?: boolean;
  alias?: string;
  id: string; repositoryId: string; request: GitImportRequest; status: string; lastCommitSha?: string;
  lastSyncedAt?: string; errorMessage?: string;
}
