/** Explicit module entry point. Keep implementation imports inside this module. */
export { GitAllowedIpService } from './git-allowed-ip-service.js';
export { GitCache } from './git-cache.js';
export { GitClient } from './git-client.js';
export { GitConnectionService } from './git-connection-service.js';
export { GitError } from './git-errors.js';
export { GitImportService } from './git-import-service.js';
export { type GitHostPolicy, gitHostPolicyFromAddresses, gitHostPolicyFromEnvironment } from './git-network.js';
export { GitRegistrationService } from './git-registration-service.js';
export { GitRepositoryAccess } from './git-repository-access.js';
export { GitRepositoryCatalog } from './git-repository-catalog.js';
export { type GitProviderId, connectionRepositoryPath, normalizeRepository } from './git-repository.js';
export { createGitSourceProvider } from './git-source-provider.js';
export { GitTokenService } from './git-token-service.js';
export { GitAllowedIpRepository } from './storage/git-allowed-ip-repository.js';
export { type GitConnection, GitConnectionRepository } from './storage/git-connection-repository.js';
export { type GitImportRecord, GitImportRepository } from './storage/git-import-repository.js';
