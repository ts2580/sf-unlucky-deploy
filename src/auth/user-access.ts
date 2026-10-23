import type { DatabaseHandle } from '../storage/database-executor.js';
import type { UserRole } from './user-repository.js';

export interface UserAccessState { role: UserRole; disabled_at: string | null }

/** Reads within the caller's transaction, so authorization and a write remain atomic. */
export async function readUserAccess(database: DatabaseHandle, userId: string): Promise<UserAccessState | undefined> {
  return database.get<UserAccessState>('SELECT role, disabled_at FROM users WHERE id = ?', userId);
}

export async function isActiveUser(database: DatabaseHandle, userId: string): Promise<boolean> {
  const user = await readUserAccess(database, userId);
  return user !== undefined && user.disabled_at === null;
}

export async function countUsers(database: DatabaseHandle): Promise<number> {
  return (await database.get<{ count: number }>('SELECT COUNT(*) count FROM users'))!.count;
}
