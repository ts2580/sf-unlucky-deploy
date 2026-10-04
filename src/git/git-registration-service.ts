import { randomUUID } from 'node:crypto';
import type { DatabaseExecutor } from '../storage/database-executor.js';
import type { GitImportRequest } from '../storage/git-import-repository.js';
import type { GitImportService } from './git-import-service.js';
import { GitError } from './git-errors.js';
import { connectionRepositoryPath, normalizeRepository, validateGitRef } from './git-repository.js';
import { safeGitPath } from './git-project-validator.js';
import type { WorkspaceSource } from '../api/workspace-contracts.js';
import { runGitOperation } from './git-diagnostics.js';
import { normalizeGitAlias } from './git-alias.js';

export interface GitRegistration {
  requiresRepositoryUrl?: boolean;
  alias?: string;
  id: string; repositoryId: string; request: GitImportRequest; status: string; lastCommitSha?: string;
  lastSyncedAt?: string; errorMessage?: string;
}
interface Row { id: string; alias: string | null; repository_url_verified: number; repository_id: string; request_json: string; status: string; last_commit_sha: string | null; last_synced_at: string | null; error_message: string | null }
export class GitRegistrationService {
  private closed = false;
  private readonly admissions = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  public constructor(private readonly database: DatabaseExecutor, private readonly imports: GitImportService,
    private readonly diagnosticsFile?: string) {}

  public async list(owner: string): Promise<GitRegistration[]> {
    return (await this.database.all<Row[]>('SELECT * FROM git_registrations WHERE owner_user_id = ? ORDER BY created_at DESC', owner)).map(map);
  }
  public async get(id: string, owner: string): Promise<GitRegistration> {
    const row = await this.database.get<Row>('SELECT * FROM git_registrations WHERE id = ? AND owner_user_id = ?', id, owner);
    if (row === undefined) throw new GitError('IMPORT_EXPIRED');
    return map(row);
  }
  public async register(owner: string, request: GitImportRequest): Promise<GitRegistration> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    if (request.ref.kind !== 'branch') throw new GitError('INVALID_REF');
    validateGitRef(request.ref);
    if (request.projectRoot !== undefined) safeGitPath(request.projectRoot, true);
    const address = normalizeRepository(request.repositoryPath, request.provider);
    const repository = await this.imports.projectRoots(owner, request);
    const projectRoot = request.projectRoot ?? (repository.projectRoots.length === 1 ? repository.projectRoots[0] : undefined);
    if (projectRoot === undefined) throw new GitError('PROJECT_SELECTION_REQUIRED');
    if (!repository.projectRoots.includes(projectRoot)) throw new GitError('DX_PROJECT_NOT_FOUND');
    if ((await this.list(owner)).length >= 50) throw new GitError('GIT_QUOTA_EXCEEDED');
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const id = randomUUID();
    // Type selection belongs to each comparison, not the saved branch.
    const { metadataType: _type, ...saved } = request;
    await this.database.run(`INSERT INTO git_registrations(id, owner_user_id, request_json, repository_id, status, created_at, repository_url_verified)
      VALUES (?, ?, ?, ?, 'PENDING', ?, 1)`, id, owner,
    JSON.stringify({ ...saved, repositoryPath: connectionRepositoryPath(address), projectRoot }), repository.repositoryId, new Date().toISOString());
    await this.sync(id, owner, true);
    return this.get(id, owner);
  }
  public async sync(id: string, owner: string, requireExpectedCommit = false): Promise<GitRegistration> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const leave = this.admit(owner);
    const prior = this.tails.get(id) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(() => runGitOperation(this.diagnosticsFile, id, 'registration-sync', async () => {
      if (this.closed) throw new GitError('IMPORT_CANCELLED');
      const registered = await this.get(id, owner);
      await this.database.run("UPDATE git_registrations SET status = 'SYNCING', error_message = NULL WHERE id = ?", id);
      try {
        await this.assertRepository(registered, owner);
        const result = await this.imports.warm(owner, registered.request, requireExpectedCommit);
        await this.database.run("UPDATE git_registrations SET status = 'READY', last_commit_sha = ?, last_synced_at = ?, error_message = NULL WHERE id = ?",
          result.commitSha, result.syncedAt, id);
      } catch (error) {
        const safe = error instanceof GitError ? error : new GitError('GIT_PROCESS_FAILED');
        await this.database.run("UPDATE git_registrations SET status = 'FAILED', error_message = ? WHERE id = ?", safe.message, id);
        throw safe;
      }
      return this.get(id, owner);
    }));
    this.tails.set(id, work);
    try { return await work; } finally { leave(); if (this.tails.get(id) === work) this.tails.delete(id); }
  }
  public async prepare(id: string, owner: string, metadataType: string,
    isolation?: { sessionId: string; jobId: string; side: string }) {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const leave = this.admit(owner);
    const prior = this.tails.get(id) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(() => runGitOperation(this.diagnosticsFile, id, 'registration-prepare', async () => {
      if (this.closed) throw new GitError('IMPORT_CANCELLED');
      const registered = await this.get(id, owner);
      await this.database.run("UPDATE git_registrations SET status = 'SYNCING', error_message = NULL WHERE id = ?", id);
      try {
        await this.assertRepository(registered, owner);
        const imported = await this.imports.prepareLatest(owner, { ...registered.request, metadataType }, isolation);
        await this.database.run(`UPDATE git_registrations SET status = 'READY', last_commit_sha = ?, last_synced_at = ?, error_message = NULL WHERE id = ?`,
          imported.expectedCommitSha, imported.provenance!.importedAt, id);
        return imported;
      } catch (error) {
        const safe = error instanceof GitError ? error : new GitError('GIT_PROCESS_FAILED');
        await this.database.run("UPDATE git_registrations SET status = 'FAILED', error_message = ? WHERE id = ?", safe.message, id);
        throw safe;
      }
    }));
    this.tails.set(id, work);
    try { return await work; } finally { leave(); if (this.tails.get(id) === work) this.tails.delete(id); }
  }
  private admit(owner: string): () => void {
    const count = this.admissions.get(owner) ?? 0;
    if (count >= 3 || [...this.admissions.values()].reduce((a, b) => a + b, 0) >= 20) throw new GitError('GIT_QUOTA_EXCEEDED');
    this.admissions.set(owner, count + 1);
    return () => {
      const left = (this.admissions.get(owner) ?? 1) - 1;
      if (left === 0) this.admissions.delete(owner); else this.admissions.set(owner, left);
    };
  }
  private async assertRepository(registered: GitRegistration, owner: string): Promise<void> {
    if (registered.requiresRepositoryUrl) throw new GitError('GIT_REPOSITORY_URL_REQUIRED');
    const current = await this.imports.inspect(registered.request, undefined, owner);
    if (current.repositoryId !== registered.repositoryId) throw new GitError('REPOSITORY_UNAVAILABLE');
  }
  public async remove(id: string, owner: string): Promise<void> {
    await this.get(id, owner);
    if (this.tails.has(id)) throw new Error('동기화 중인 브랜치는 제거할 수 없습니다.');
    await this.database.run('DELETE FROM git_registrations WHERE id = ? AND owner_user_id = ?', id, owner);
  }
  public async setAlias(id: string, owner: string, value: string): Promise<GitRegistration> {
    const alias = normalizeGitAlias(value);
    const result = await this.database.run('UPDATE git_registrations SET alias = ? WHERE id = ? AND owner_user_id = ?', alias, id, owner);
    if (result.changes !== 1) throw new GitError('IMPORT_EXPIRED');
    return this.get(id, owner);
  }
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.tails.values());
  }
  public async sources(owner: string): Promise<WorkspaceSource[]> {
    const connections = await this.database.all<{ id: string; alias: string | null; repository_path: string | null }[]>(
      "SELECT id, alias, repository_path FROM git_connections WHERE owner_user_id = ? AND status <> 'REVOKED'", owner,
    );
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    return (await this.list(owner)).filter((item) => !item.requiresRepositoryUrl).map((item) => {
      const address = normalizeRepository(item.request.repositoryPath, item.request.provider);
      const connection = item.request.connectionId === undefined ? undefined : byId.get(item.request.connectionId);
      const name = item.alias ?? (connection?.alias == null ? address.repositoryPath
        : connection.repository_path == null ? `${connection.alias} · ${address.repositoryPath}` : connection.alias);
      return { id: `git-registered:${item.id}`, kind: 'local', location: 'git',
        label: `${name} · ${item.request.ref.name}`,
        detail: `${address.host}/${address.repositoryPath} · 프로젝트 ${item.request.projectRoot ?? '.'} · 비교 시작 시 자동 동기화` };
    });
  }
}
function map(row: Row): GitRegistration {
  return { id: row.id, repositoryId: row.repository_id, request: JSON.parse(row.request_json) as GitImportRequest, status: row.status,
    ...(row.repository_url_verified === 0 ? { requiresRepositoryUrl: true } : {}),
    ...(row.alias == null ? {} : { alias: row.alias }),
    ...(row.last_commit_sha === null ? {} : { lastCommitSha: row.last_commit_sha }),
    ...(row.last_synced_at === null ? {} : { lastSyncedAt: row.last_synced_at }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }) };
}
