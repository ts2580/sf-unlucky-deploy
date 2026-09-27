import type { DatabaseExecutor } from './database-executor.js';
import { runInImmediateTransaction } from './transaction.js';

const DEFAULT_TEST_CLASS_SUFFIX = '_Test';

export interface UserSettings {
  testClassSuffix: string;
  maximumComparisonFiles: number;
}

export class UserSettingsRepository {
  public constructor(
    private readonly database: DatabaseExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async get(userId: string): Promise<UserSettings> {
    const row = await this.database.get<{ test_class_suffix: string; maximum_comparison_files: number }>(`
      SELECT test_class_suffix, maximum_comparison_files FROM user_settings WHERE user_id = ?
    `, userId);
    return { testClassSuffix: row?.test_class_suffix ?? DEFAULT_TEST_CLASS_SUFFIX,
      maximumComparisonFiles: row?.maximum_comparison_files ?? 2000 };
  }

  public async update(userId: string, testClassSuffixInput: string, maximumComparisonFilesInput?: unknown): Promise<UserSettings> {
    const testClassSuffix = normalizeTestClassSuffix(testClassSuffixInput);
    if (maximumComparisonFilesInput !== undefined && (typeof maximumComparisonFilesInput !== 'number'
      || !Number.isSafeInteger(maximumComparisonFilesInput) || maximumComparisonFilesInput < 1 || maximumComparisonFilesInput > 50_000)) {
      throw new Error('최대 비교 파일 수는 1~50,000 사이의 정수로 입력하세요.');
    }
    const maximumComparisonFiles = maximumComparisonFilesInput as number | undefined;
    const timestamp = this.now();
    await runInImmediateTransaction(this.database, async (transaction) => {
      await transaction.run(`
        INSERT INTO user_settings (user_id, test_class_suffix, maximum_comparison_files, updated_at)
        VALUES (?, ?, COALESCE(?, 2000), ?)
        ON CONFLICT(user_id) DO UPDATE SET
          test_class_suffix = excluded.test_class_suffix,
          maximum_comparison_files = COALESCE(?, user_settings.maximum_comparison_files),
          updated_at = excluded.updated_at
      `, userId, testClassSuffix, maximumComparisonFiles ?? null, timestamp, maximumComparisonFiles ?? null);
      await transaction.run(`
        INSERT INTO audit_events (
          actor_user_id, event_type, entity_type, entity_id, detail_json, created_at
        ) VALUES (?, 'USER_SETTINGS_UPDATED', 'USER_SETTINGS', ?, ?, ?)
      `, userId, userId, JSON.stringify({ testClassSuffix, ...(maximumComparisonFiles === undefined ? {} : { maximumComparisonFiles }) }), timestamp);
    });
    return await this.get(userId);
  }
}

function normalizeTestClassSuffix(value: string): string {
  const suffix = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u.test(suffix)) {
    throw new Error('테스트 클래스 접미사는 영문자, 숫자, 밑줄로 1~40자까지 입력하세요. 첫 글자는 숫자일 수 없습니다.');
  }
  return suffix;
}
