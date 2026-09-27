import type { WorkspaceSource } from '../api/workspace-contracts.js';
import { GitError, type GitErrorCode } from '../git/git-errors.js';
import type { GitProviderId, GitRef } from '../git/git-repository.js';
import type { DatabaseExecutor } from './database-executor.js';

export type GitImportStatus = 'QUEUED' | 'FETCHING' | 'SELECTING' | 'MATERIALIZING' | 'READY'
  | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'DELETED';
export interface GitImportRequest {
  provider: GitProviderId;
  repositoryPath: string;
  ref: GitRef;
  expectedCommitSha: string;
  projectRoot?: string;
  metadataType?: string;
  connectionId?: string;
}
export interface GitImportRecord extends GitImportRequest {
  id: string;
  ownerUserId: string;
  status: GitImportStatus;
  projectRoots: string[];
  provenance?: NonNullable<WorkspaceSource['provenance']>;
  sizeBytes: number;
  errorCode?: GitErrorCode;
  createdAt: string;
  updatedAt: string;
}
interface Row {
  id: string; owner_user_id: string; connection_id: string | null; provider: GitProviderId;
  repository_path: string; ref_kind: GitRef['kind']; ref_name: string; expected_commit_sha: string;
  metadata_type: string | null;
  project_root: string | null; status: GitImportStatus; project_roots_json: string;
  source_provenance_json: string | null; size_bytes: number; safe_error_code: GitErrorCode | null;
  created_at: string; updated_at: string;
}

export class GitImportRepository {
  public constructor(private readonly database: DatabaseExecutor) {}

  public async create(id: string, owner: string, input: GitImportRequest): Promise<GitImportRecord> {
    const now = new Date().toISOString();
    await this.database.run(`INSERT INTO git_imports (id, owner_user_id, connection_id, provider,
      repository_path, ref_kind, ref_name, expected_commit_sha, project_root, metadata_type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`, id, owner, input.connectionId ?? null,
    input.provider, input.repositoryPath, input.ref.kind, input.ref.name, input.expectedCommitSha,
    input.projectRoot ?? null, input.metadataType ?? null, now, now);
    return this.get(id, owner);
  }

  public async get(id: string, owner: string): Promise<GitImportRecord> {
    const row = await this.database.get<Row>('SELECT * FROM git_imports WHERE id = ? AND owner_user_id = ?', id, owner);
    if (row === undefined) throw new GitError('IMPORT_EXPIRED');
    return map(row);
  }

  public async list(owner: string): Promise<GitImportRecord[]> {
    return (await this.database.all<Row[]>(`SELECT * FROM git_imports WHERE owner_user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 100`, owner)).map(map);
  }

  public async transition(id: string, owner: string, from: readonly GitImportStatus[], status: GitImportStatus,
    update: { projectRoots?: string[]; provenance?: GitImportRecord['provenance']; sizeBytes?: number; errorCode?: GitErrorCode } = {}): Promise<void> {
    const result = await this.database.run(`UPDATE git_imports SET status = ?, updated_at = ?,
      project_roots_json = COALESCE(?, project_roots_json), source_provenance_json = COALESCE(?, source_provenance_json),
      size_bytes = COALESCE(?, size_bytes), safe_error_code = ?
      WHERE id = ? AND owner_user_id = ? AND status IN (${from.map(() => '?').join(',')})`,
    status, new Date().toISOString(), update.projectRoots === undefined ? null : JSON.stringify(update.projectRoots),
    update.provenance === undefined ? null : JSON.stringify(update.provenance), update.sizeBytes ?? null,
    update.errorCode ?? null, id, owner, ...from);
    if (result.changes !== 1) throw new GitError('IMPORT_EXPIRED');
  }

  // Imported directories are ephemeral. A restart retains history, never trusts
  // stale local paths, and requires a new import before a source can be used.
  public async recover(): Promise<void> {
    await this.database.run(`UPDATE git_imports SET status = 'EXPIRED', safe_error_code = 'IMPORT_EXPIRED', updated_at = ?
      WHERE status IN ('QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING', 'READY')`, new Date().toISOString());
  }
}

function map(row: Row): GitImportRecord {
  return { id: row.id, ownerUserId: row.owner_user_id, provider: row.provider, repositoryPath: row.repository_path,
    ref: { kind: row.ref_kind, name: row.ref_name }, expectedCommitSha: row.expected_commit_sha,
    ...(row.connection_id === null ? {} : { connectionId: row.connection_id }),
    ...(row.metadata_type == null ? {} : { metadataType: row.metadata_type }),
    ...(row.project_root === null ? {} : { projectRoot: row.project_root }),
    status: row.status, projectRoots: JSON.parse(row.project_roots_json) as string[],
    ...(row.source_provenance_json === null ? {} : { provenance: JSON.parse(row.source_provenance_json) as NonNullable<GitImportRecord['provenance']> }),
    sizeBytes: row.size_bytes, ...(row.safe_error_code === null ? {} : { errorCode: row.safe_error_code }),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
