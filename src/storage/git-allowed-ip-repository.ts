import type { DatabaseExecutor } from './database-executor.js';
import { runInImmediateTransaction } from './transaction.js';
import { normalizeGitHostIpAddress } from '../git/git-network.js';

export interface GitAllowedIp { address: string; createdAt: string }

export class GitAllowedIpRepository {
  public constructor(private readonly database: DatabaseExecutor, private readonly now: () => string = () => new Date().toISOString()) {}

  public async list(): Promise<GitAllowedIp[]> {
    return await this.database.all<GitAllowedIp[]>(`SELECT address, created_at createdAt FROM git_allowed_ips ORDER BY address`);
  }

  public async add(actorUserId: string, value: string): Promise<void> {
    const address = normalizeGitHostIpAddress(value);
    const createdAt = this.now();
    await runInImmediateTransaction(this.database, async (transaction) => {
      const result = await transaction.run('INSERT INTO git_allowed_ips (address, created_by, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING',
        address, actorUserId, createdAt);
      if (result.changes === 0) return;
      await transaction.run(`INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
        VALUES (?, 'GIT_ALLOWED_IP_ADDED', 'GIT_ALLOWED_IP', ?, ?, ?)`, actorUserId, address, JSON.stringify({ address }), createdAt);
    });
  }

  public async remove(actorUserId: string, value: string): Promise<void> {
    const address = normalizeGitHostIpAddress(value);
    const createdAt = this.now();
    await runInImmediateTransaction(this.database, async (transaction) => {
      const result = await transaction.run('DELETE FROM git_allowed_ips WHERE address = ?', address);
      if (result.changes === 0) return;
      await transaction.run(`INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
        VALUES (?, 'GIT_ALLOWED_IP_REMOVED', 'GIT_ALLOWED_IP', ?, ?, ?)`, actorUserId, address, JSON.stringify({ address }), createdAt);
    });
  }
}
