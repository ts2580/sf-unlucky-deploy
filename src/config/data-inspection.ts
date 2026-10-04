import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sqlite3 from 'sqlite3';

export interface DataInspection {
  exists: boolean;
  accessible: boolean;
  databaseExists: boolean;
  mode?: 'local' | 'multiuser';
  uncertain: boolean;
  empty: boolean;
}

/** Immutable SQLite avoids even WAL/shm creation. Uncheckpointed databases are never treated as certain. */
export async function inspectDataDirectory(directory: string): Promise<DataInspection> {
  const result: DataInspection = { exists: false, accessible: false, databaseExists: false, uncertain: false, empty: false };
  try {
    const stat = await lstat(directory);
    result.exists = true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return result;
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    result.accessible = true;
  } catch (error) {
    if (!notFound(error)) return result;
    // No write probe: report access to the nearest existing ancestor.
    let parent = path.dirname(directory);
    while (true) {
      try { await access(parent, constants.W_OK | constants.X_OK); result.accessible = true; break; }
      catch (parentError) {
        if (!notFound(parentError) || path.dirname(parent) === parent) break;
        parent = path.dirname(parent);
      }
    }
    result.empty = result.accessible;
    return result;
  }
  const databasePath = path.join(directory, 'sfud.db');
  try {
    const stat = await lstat(databasePath);
    result.databaseExists = true;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { result.uncertain = true; return result; }
    await access(databasePath, constants.R_OK);
    try { if ((await lstat(`${databasePath}-wal`)).size > 0) { result.uncertain = true; return result; } }
    catch (error) { if (!notFound(error)) { result.uncertain = true; return result; } }
  } catch (error) {
    if (!notFound(error)) { result.uncertain = true; return result; }
    // Existing nonempty directory must not be mistaken for a fresh installation.
    const { readdir } = await import('node:fs/promises');
    result.empty = (await readdir(directory)).length === 0;
    return result;
  }
  const uri = pathToFileURL(databasePath);
  uri.search = '?mode=ro&immutable=1';
  let db: sqlite3.Database | undefined;
  try {
    db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const opened = new sqlite3.Database(uri.href, sqlite3.OPEN_READONLY | sqlite3.OPEN_URI, (error) => error === null ? resolve(opened) : reject(error));
    });
    const row = await new Promise<{ mode: string } | undefined>((resolve, reject) => {
      db!.get('SELECT mode FROM runtime_mode WHERE id = 1', (error, value: { mode: string } | undefined) => error === null ? resolve(value) : reject(error));
    });
    if (row?.mode === 'local' || row?.mode === 'multiuser') result.mode = row.mode;
    else {
      const users = await new Promise<{ count: number }>((resolve, reject) => {
        db!.get('SELECT COUNT(*) count FROM users', (error, value: { count: number }) => error === null ? resolve(value) : reject(error));
      });
      if (users.count > 0) result.mode = 'multiuser';
      else result.uncertain = true;
    }
  } catch { result.uncertain = true; }
  finally { if (db !== undefined) await new Promise<void>((resolve) => db!.close(() => resolve())); }
  return result;
}
function notFound(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'; }
