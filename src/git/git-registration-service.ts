import { randomUUID } from 'node:crypto';
import type { DatabaseExecutor } from '../storage/database-executor.js';
import type { GitImportRequest } from '../storage/git-import-repository.js';
import type { GitImportService } from './git-import-service.js';
import { GitError } from './git-errors.js';
import { normalizeRepository, validateGitRef } from './git-repository.js';
import { safeGitPath } from './git-project-validator.js';
import type { WorkspaceSource } from '../api/workspace-contracts.js';

export interface GitRegistration {
  id: string; repositoryId: string; request: GitImportRequest; status: string; lastCommitSha?: string;
  lastSyncedAt?: string; errorMessage?: string;
}
interface Row { id: string; repository_id: string; request_json: string; status: string; last_commit_sha: string | null; last_synced_at: string | null; error_message: string | null }
export class GitRegistrationService {
  private closed = false;
  private readonly admissions = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  public constructor(private readonly database: DatabaseExecutor, private readonly imports: GitImportService) {}

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
    safeGitPath(request.projectRoot ?? '.', true);
    const address = normalizeRepository(request.repositoryPath, request.provider);
    const repository = await this.imports.inspect(request, undefined, owner);
    if ((await this.list(owner)).length >= 50) throw new GitError('GIT_QUOTA_EXCEEDED');
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const id = randomUUID();
    // Type selection belongs to each comparison, not the saved branch.
    const { metadataType: _type, ...saved } = request;
    await this.database.run(`INSERT INTO git_registrations(id, owner_user_id, request_json, repository_id, status, created_at)
      VALUES (?, ?, ?, ?, 'PENDING', ?)`, id, owner,
    JSON.stringify({ ...saved, repositoryPath: address.repositoryPath, projectRoot: request.projectRoot ?? '.' }), repository.repositoryId, new Date().toISOString());
    await this.sync(id, owner);
    return this.get(id, owner);
  }
  public async sync(id: string, owner: string): Promise<GitRegistration> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const leave = this.admit(owner);
    const prior = this.tails.get(id) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(async () => {
      if (this.closed) throw new GitError('IMPORT_CANCELLED');
      const registered = await this.get(id, owner);
      await this.database.run("UPDATE git_registrations SET status = 'SYNCING', error_message = NULL WHERE id = ?", id);
      try {
        await this.assertRepository(registered, owner);
        const result = await this.imports.warm(owner, registered.request);
        await this.database.run("UPDATE git_registrations SET status = 'READY', last_commit_sha = ?, last_synced_at = ?, error_message = NULL WHERE id = ?",
          result.commitSha, result.syncedAt, id);
      } catch (error) {
        const safe = error instanceof GitError ? error : new GitError('GIT_PROCESS_FAILED');
        await this.database.run("UPDATE git_registrations SET status = 'FAILED', error_message = ? WHERE id = ?", safe.message, id);
        throw safe;
      }
      return this.get(id, owner);
    });
    this.tails.set(id, work);
    try { return await work; } finally { leave(); if (this.tails.get(id) === work) this.tails.delete(id); }
  }
  public async prepare(id: string, owner: string, metadataType: string,
    isolation?: { sessionId: string; jobId: string; side: string }) {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const leave = this.admit(owner);
    const prior = this.tails.get(id) ?? Promise.resolve();
    const work = prior.catch(() => undefined).then(async () => {
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
    });
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
    const current = await this.imports.inspect(registered.request, undefined, owner);
    if (current.repositoryId !== registered.repositoryId) throw new GitError('REPOSITORY_UNAVAILABLE');
  }
  public async remove(id: string, owner: string): Promise<void> {
    await this.get(id, owner);
    if (this.tails.has(id)) throw new Error('동기화 중인 브랜치는 제거할 수 없습니다.');
    await this.database.run('DELETE FROM git_registrations WHERE id = ? AND owner_user_id = ?', id, owner);
  }
  public async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.tails.values());
  }
  public async sources(owner: string): Promise<WorkspaceSource[]> {
    return (await this.list(owner)).map((item) => ({ id: `git-registered:${item.id}`, kind: 'local', location: 'git',
      label: `${item.request.repositoryPath} · ${item.request.ref.name}`,
      detail: '등록 브랜치 · 비교 시작 시 자동 동기화' }));
  }
}
function map(row: Row): GitRegistration {
  return { id: row.id, repositoryId: row.repository_id, request: JSON.parse(row.request_json) as GitImportRequest, status: row.status,
    ...(row.last_commit_sha === null ? {} : { lastCommitSha: row.last_commit_sha }),
    ...(row.last_synced_at === null ? {} : { lastSyncedAt: row.last_synced_at }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }) };
}
