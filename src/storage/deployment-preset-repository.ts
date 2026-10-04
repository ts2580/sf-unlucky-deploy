import { randomUUID } from 'node:crypto';
import type { DatabaseExecutor } from './database-executor.js';
import type { DeploymentPresetSummary, DeploymentSelection } from '../api/deployment-preset-contracts.js';
import type { OrgIdentitySnapshot } from '../deploy/org-identity.js';
import type { GitImportRequest } from './git-import-repository.js';
export type SavedSource = { kind: 'org'; identity: OrgIdentitySnapshot } | { kind: 'project'; id: string } | {
  kind: 'git'; registrationId?: string; request: GitImportRequest; repositoryId: string;
};
export interface SavedDeploymentSelection { options: Omit<DeploymentSelection, 'sourceId' | 'targetId'>; source: SavedSource; target: SavedSource }
interface Row { id: string; name: string; settings_json: string; created_at: string; updated_at: string }
export class DeploymentPresetRepository {
  public constructor(private readonly database: DatabaseExecutor, private readonly now: () => string = () => new Date().toISOString()) {}
  public async list(owner: string): Promise<DeploymentPresetSummary[]> {
    return (await this.database.all<Row[]>('SELECT * FROM deployment_presets WHERE owner_user_id = ? ORDER BY updated_at DESC, id', owner)).map(summary);
  }
  public async get(owner: string, id: string): Promise<{ preset: DeploymentPresetSummary; settings: SavedDeploymentSelection }> {
    const row = await this.database.get<Row>('SELECT * FROM deployment_presets WHERE owner_user_id = ? AND id = ?', owner, id);
    if (row === undefined) throw new Error('저장 설정을 찾을 수 없습니다.');
    return { preset: summary(row), settings: JSON.parse(row.settings_json) as SavedDeploymentSelection };
  }
  public async save(owner: string, name: string, settings: SavedDeploymentSelection, existingId?: string): Promise<DeploymentPresetSummary> {
    if (!name.trim() || name.length > 80) throw new Error('설정 이름은 1~80자로 입력하세요.');
    const json = JSON.stringify(settings);
    if (Buffer.byteLength(json) > 32_768) throw new Error('저장 설정이 너무 큽니다.');
    const id = existingId ?? randomUUID(); const now = this.now();
    await this.database.transaction(async (db) => {
      if (existingId === undefined) {
        const count = await db.get<{ count: number }>('SELECT COUNT(*) count FROM deployment_presets WHERE owner_user_id = ?', owner);
        if ((count?.count ?? 0) >= 50) throw new Error('저장 설정은 최대 50개입니다.');
        await db.run('INSERT INTO deployment_presets(id, owner_user_id, name, schema_version, settings_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)', id, owner, name.trim(), json, now, now);
      } else {
        const result = await db.run('UPDATE deployment_presets SET name = ?, settings_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?', name.trim(), json, now, id, owner);
        if (result.changes !== 1) throw new Error('저장 설정을 찾을 수 없습니다.');
      }
    });
    return (await this.get(owner, id)).preset;
  }
  public async remove(owner: string, id: string): Promise<void> {
    const result = await this.database.run('DELETE FROM deployment_presets WHERE id = ? AND owner_user_id = ?', id, owner);
    if (result.changes !== 1) throw new Error('저장 설정을 찾을 수 없습니다.');
  }
}
function summary(row: Row): DeploymentPresetSummary { return { id: row.id, name: row.name, schemaVersion: 1, createdAt: row.created_at, updatedAt: row.updated_at }; }
