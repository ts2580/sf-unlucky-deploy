import { randomUUID } from 'node:crypto';
import type { DatabaseExecutor } from './database-executor.js';
import type { SavedDeploymentSelection } from './deployment-preset-repository.js';
import type { DeploymentDraft } from '../api/deployment-draft-contracts.js';
interface Row { id: string; tab_id: string; settings_json: string; expires_at: string; updated_at: string }
export class DeploymentDraftRepository {
  public constructor(private readonly database: DatabaseExecutor, private readonly now: () => string = () => new Date().toISOString()) {}
  public async list(owner: string): Promise<DeploymentDraft[]> {
    return (await this.database.all<Row[]>('SELECT * FROM deployment_drafts WHERE owner_user_id = ? AND expires_at > ? ORDER BY updated_at DESC', owner, this.now())).map(summary);
  }
  public async get(owner: string, id: string): Promise<{ draft: DeploymentDraft; settings: SavedDeploymentSelection }> {
    const row = await this.database.get<Row>('SELECT * FROM deployment_drafts WHERE owner_user_id = ? AND id = ? AND expires_at > ?', owner, id, this.now());
    if (row === undefined) throw new Error('선택 초안이 없거나 만료되었습니다.');
    return { draft: summary(row), settings: JSON.parse(row.settings_json) as SavedDeploymentSelection };
  }
  public async reserveRevision(): Promise<number> {
    return this.database.transaction(async (db) => {
      await db.run('UPDATE deployment_draft_revision SET revision = revision + 1 WHERE id = 1');
      return (await db.get<{ revision: number }>('SELECT revision FROM deployment_draft_revision WHERE id = 1'))!.revision;
    });
  }
  public async save(owner: string, tabId: string, settings: SavedDeploymentSelection, revision?: number): Promise<DeploymentDraft> {
    const receivedRevision = revision ?? await this.reserveRevision();
    const json = JSON.stringify(settings); if (Buffer.byteLength(json) > 32_768) throw new Error('선택 초안이 너무 큽니다.');
    const now = this.now(); const expiresAt = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
    const id = await this.database.transaction(async (db) => {
      await db.run('DELETE FROM deployment_drafts WHERE owner_user_id = ? AND expires_at <= ?', owner, now);
      const existing = await db.get<{ id: string; revision: number }>('SELECT id, revision FROM deployment_drafts WHERE owner_user_id = ? AND tab_id = ?', owner, tabId);
      if (existing !== undefined) {
        if (existing.revision >= receivedRevision) throw new Error('더 최근 요청이 초안을 갱신했습니다. 이전 요청은 적용하지 않았습니다.');
        await db.run('UPDATE deployment_drafts SET settings_json = ?, updated_at = ?, expires_at = ?, revision = ? WHERE owner_user_id = ? AND id = ?', json, now, expiresAt, receivedRevision, owner, existing.id); return existing.id;
      }
      const count = await db.get<{ count: number }>('SELECT COUNT(*) count FROM deployment_drafts WHERE owner_user_id = ?', owner);
      if ((count?.count ?? 0) >= 20) throw new Error('선택 초안은 최대 20개입니다. 이전 초안을 먼저 삭제하세요.');
      const nextId = randomUUID(); await db.run('INSERT INTO deployment_drafts(id, owner_user_id, tab_id, settings_json, expires_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?)', nextId, owner, tabId, json, expiresAt, now, receivedRevision); return nextId;
    });
    return (await this.get(owner, id)).draft;
  }
  public async remove(owner: string, id: string): Promise<void> {
    const result = await this.database.run('DELETE FROM deployment_drafts WHERE owner_user_id = ? AND id = ?', owner, id);
    if (result.changes !== 1) throw new Error('선택 초안을 찾을 수 없습니다.');
  }
}
function summary(row: Row): DeploymentDraft { return { id: row.id, tabId: row.tab_id, expiresAt: row.expires_at, updatedAt: row.updated_at }; }
