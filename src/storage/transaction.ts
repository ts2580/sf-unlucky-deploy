import type { DatabaseExecutor, DatabaseHandle } from './database-executor.js';

export function runInImmediateTransaction<T>(
  database: DatabaseExecutor,
  operation: (transaction: DatabaseHandle) => Promise<T>,
): Promise<T> {
  return database.transaction(operation);
}
