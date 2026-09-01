import type { Database } from 'sqlite';

import { runInImmediateTransaction } from './transaction.js';

export const DEFAULT_TEST_CLASS_SUFFIX = '_Test';

export interface UserSettings {
  testClassSuffix: string;
}

export class UserSettingsRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async get(userId: string): Promise<UserSettings> {
    const row = await this.database.get<{ test_class_suffix: string }>(`
      SELECT test_class_suffix FROM user_settings WHERE user_id = ?
    `, userId);
    return { testClassSuffix: row?.test_class_suffix ?? DEFAULT_TEST_CLASS_SUFFIX };
  }

  public async update(userId: string, testClassSuffixInput: string): Promise<UserSettings> {
    const testClassSuffix = normalizeTestClassSuffix(testClassSuffixInput);
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async () => {
      await this.database.run(`
        INSERT INTO user_settings (user_id, test_class_suffix, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          test_class_suffix = excluded.test_class_suffix,
          updated_at = excluded.updated_at
      `, userId, testClassSuffix, timestamp);
      await this.database.run(`
        INSERT INTO audit_events (
          actor_user_id, event_type, entity_type, entity_id, detail_json, created_at
        ) VALUES (?, 'USER_SETTINGS_UPDATED', 'USER_SETTINGS', ?, ?, ?)
      `, userId, userId, JSON.stringify({ testClassSuffix }), timestamp);
    });
    return { testClassSuffix };
  }
}

export function normalizeTestClassSuffix(value: string): string {
  const suffix = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(suffix)) {
    throw new Error('테스트 클래스 접미사는 영문자, 숫자, 밑줄로 1~40자까지 입력하세요. 첫 글자는 숫자일 수 없습니다.');
  }
  return suffix;
}
