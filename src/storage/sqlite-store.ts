import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

import { applyMigrations } from './migrations.js';
import { DatabaseExecutor } from './database-executor.js';

export interface SqliteStoreOptions {
  databasePath: string;
  busyTimeoutMs?: number;
  now?: () => string;
}

export interface SqliteStore {
  database: DatabaseExecutor;
  databasePath: string;
  close(): Promise<void>;
}

export async function openSqliteStore(options: SqliteStoreOptions): Promise<SqliteStore> {
  const databasePath = options.databasePath === ':memory:'
    ? options.databasePath
    : path.resolve(options.databasePath);

  if (databasePath !== ':memory:') {
    const directory = path.dirname(databasePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const rawDatabase = await open({
    filename: databasePath,
    driver: sqlite3.Database,
  });
  try {
    await rawDatabase.exec('PRAGMA foreign_keys = ON');
    await rawDatabase.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    await rawDatabase.exec('PRAGMA journal_mode = WAL');
    await applyMigrations(rawDatabase, options.now ?? (() => new Date().toISOString()));

    if (databasePath !== ':memory:') {
      await Promise.all([
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ].map(async (filePath) => chmodIfExists(filePath, 0o600)));
    }
  } catch (error) {
    await rawDatabase.close();
    throw error;
  }

  const database = new DatabaseExecutor(rawDatabase);
  return {
    database,
    databasePath,
    close: async () => database.close(),
  };
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
}

export function resolveDatabasePath(cwd = process.cwd(), dataDirectory?: string): string {
  const directory = dataDirectory ?? process.env.SFUD_DATA_DIR ?? path.join(cwd, '.sfud');
  return path.resolve(directory, 'sfud.db');
}
