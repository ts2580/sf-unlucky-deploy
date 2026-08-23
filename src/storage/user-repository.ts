import { randomUUID } from 'node:crypto';

import type { Database } from 'sqlite';

import { runInImmediateTransaction } from './transaction.js';

export type UserRole = 'VIEWER' | 'OPERATOR' | 'DEPLOYER' | 'ADMIN';

export interface SfudUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: UserRole;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export class UserRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public async create(input: CreateUserInput): Promise<SfudUser> {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (email.length === 0 || !email.includes('@')) {
      throw new Error('유효한 사용자 이메일이 필요합니다.');
    }
    if (displayName.length === 0) {
      throw new Error('사용자 표시 이름이 필요합니다.');
    }

    const id = this.createId();
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async () => {
      await this.database.run(`
        INSERT INTO users (id, email, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, id, email, displayName, input.role, timestamp, timestamp);
      await this.database.run(`
        INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, detail_json, created_at)
        VALUES (?, 'USER_CREATED', 'USER', ?, ?, ?)
      `, id, id, JSON.stringify({ email, role: input.role }), timestamp);
    });
    return this.getRequired(id);
  }

  public async get(id: string): Promise<SfudUser | undefined> {
    const row = await this.database.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    return row === undefined ? undefined : mapUser(row);
  }

  public async getRequired(id: string): Promise<SfudUser> {
    const user = await this.get(id);
    if (user === undefined) {
      throw new Error(`사용자를 찾을 수 없습니다: ${id}`);
    }
    return user;
  }
}

function mapUser(row: UserRow): SfudUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    ...(row.disabled_at === null ? {} : { disabledAt: row.disabled_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
