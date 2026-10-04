import type { Database } from 'sqlite';
import { connectionRepositoryPath, normalizeRepository, type GitProviderId } from '../git/git-repository.js';
import { GitError } from '../git/git-errors.js';

interface Connection { provider: GitProviderId; provider_host: string; repository_path: string | null }

// Once, inside migration 39's transaction. No network or credential decryption.
export async function repairLegacyGitRepositoryUrls(database: Database): Promise<void> {
  const resolve = async (owner: string, provider: GitProviderId, value: string, connectionId?: string | null, provenance?: string | null): Promise<string | undefined> => {
    try {
      if (typeof value !== 'string') return undefined;
      if (value.includes('://')) return connectionRepositoryPath(normalizeRepository(value, provider));
      if (connectionId) {
        const connection = await database.get<Connection>('SELECT provider, provider_host, repository_path FROM git_connections WHERE id = ? AND owner_user_id = ?', connectionId, owner);
        if (connection === undefined || connection.provider !== provider) return undefined;
        if (connection.repository_path !== null) {
          const bound = normalizeRepository(connection.repository_path, provider);
          return bound.host === connection.provider_host && bound.repositoryPath === value ? connectionRepositoryPath(bound) : undefined;
        }
        const cloud = normalizeRepository(value, provider);
        return cloud.host === connection.provider_host ? cloud.repositoryPath : undefined;
      }
      if (provenance) {
        const recorded = JSON.parse(provenance) as { provider?: string; host?: string; repositoryPath?: string; sourceOwnerUserId?: string };
        if (recorded === null || typeof recorded !== 'object' || recorded.provider !== provider || recorded.sourceOwnerUserId !== owner || recorded.repositoryPath !== value || !recorded.host) return undefined;
        const address = normalizeRepository(`https://${recorded.host}/${value}.git`, provider);
        return address.host === recorded.host && address.repositoryPath === value ? connectionRepositoryPath(address) : undefined;
      }
    } catch (error) {
      if (!(error instanceof GitError || error instanceof SyntaxError)) throw error;
    }
    return undefined;
  };
  const imports = await database.all<Array<{ id: string; owner_user_id: string; provider: GitProviderId; repository_path: string; connection_id: string | null; source_provenance_json: string | null }>>('SELECT id, owner_user_id, provider, repository_path, connection_id, source_provenance_json FROM git_imports');
  for (const row of imports) {
    const url = await resolve(row.owner_user_id, row.provider, row.repository_path, row.connection_id, row.source_provenance_json);
    if (url !== undefined) await database.run('UPDATE git_imports SET repository_path = ?, repository_url_verified = 1 WHERE id = ?', url, row.id);
    else await database.run("UPDATE git_imports SET safe_error_code = 'GIT_REPOSITORY_URL_REQUIRED', status = CASE WHEN status = 'DELETED' THEN status ELSE 'FAILED' END WHERE id = ?", row.id);
  }
  const registrations = await database.all<Array<{ id: string; owner_user_id: string; request_json: string }>>('SELECT id, owner_user_id, request_json FROM git_registrations');
  for (const row of registrations) {
    const request = JSON.parse(row.request_json) as { provider: GitProviderId; repositoryPath: string; connectionId?: string };
    const url = await resolve(row.owner_user_id, request.provider, request.repositoryPath, request.connectionId);
    if (url !== undefined) await database.run('UPDATE git_registrations SET request_json = ?, repository_url_verified = 1 WHERE id = ?', JSON.stringify({ ...request, repositoryPath: url }), row.id);
    else await database.run("UPDATE git_registrations SET status = 'FAILED', error_message = ? WHERE id = ?", new GitError('GIT_REPOSITORY_URL_REQUIRED').message, row.id);
  }
}
