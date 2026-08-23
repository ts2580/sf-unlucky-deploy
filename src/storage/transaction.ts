import type { Database } from 'sqlite';

const transactionTails = new WeakMap<Database, Promise<void>>();

export function runInImmediateTransaction<T>(
  database: Database,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = transactionTails.get(database) ?? Promise.resolve();
  const result = previous.then(async () => {
    await database.exec('BEGIN IMMEDIATE');
    try {
      const value = await operation();
      await database.exec('COMMIT');
      return value;
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  });
  transactionTails.set(database, result.then(() => undefined, () => undefined));
  return result;
}
