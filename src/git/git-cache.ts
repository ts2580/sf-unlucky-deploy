import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, lstat, chmod, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open, type Database } from 'sqlite';
import sqlite3 from 'sqlite3';
import { directorySize } from './git-process.js';
import { GitError } from './git-errors.js';

// A separate SQLite exclusive transaction is an OS-backed lifetime lock. A
// crashed process releases it; a second runtime cannot recover a live runtime.
export class GitCache {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly sizes = new Map<string, number>();
  private readonly active = new Set<string>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private constructor(public readonly root: string, private readonly lock: Database,
    private readonly temporary: boolean, private readonly repositoryLimit: number,
    private readonly totalLimit: number) {}

  public static async create(databasePath: string, repositoryLimit = 100 * 1024 * 1024,
    totalLimit = 2 * 1024 * 1024 * 1024): Promise<GitCache> {
    const temporary = databasePath === ':memory:';
    const root = temporary ? await mkdtemp(path.join(os.tmpdir(), 'sfud-git-cache-'))
      : path.join(path.dirname(path.resolve(databasePath)), 'git-cache');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new GitError('UNSAFE_PROJECT_PATH');
    await chmod(root, 0o700);
    const lock = await open({ filename: path.join(root, 'owner.sqlite'), driver: sqlite3.Database });
    try {
      await lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
      const cache = new GitCache(root, lock, temporary, repositoryLimit, totalLimit);
      for (const name of await readdir(root)) {
        if (/^[a-f0-9]{64}$/u.test(name)) {
          if (!(await lstat(path.join(root, name))).isDirectory()) throw new GitError('UNSAFE_PROJECT_PATH');
          cache.sizes.set(name, await directorySize(path.join(root, name)));
        }
      }
      return cache;
    } catch (error) {
      await lock.close();
      if (temporary) await rm(root, { recursive: true, force: true });
      throw new Error('Git 캐시를 열 수 없습니다. 같은 데이터 경로를 사용하는 서버 또는 저장 공간을 확인하세요.', { cause: error });
    }
  }

  public async acquire(identity: readonly string[], signal?: AbortSignal): Promise<{
    directory: string; release(): Promise<void>; checkBytes(bytes: number): void;
  }> {
    if (this.closed) throw new GitError('IMPORT_CANCELLED');
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const prior = this.tails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = prior.then(() => held);
    this.tails.set(key, tail);
    await prior;
    const directory = path.join(this.root, key);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        const bytes = await directorySize(directory);
        if (bytes > this.repositoryLimit) throw new GitError('GIT_QUOTA_EXCEEDED');
        this.sizes.set(key, bytes); await utimes(directory, new Date(), new Date());
      }
      catch {
        try { await rm(directory, { recursive: true, force: true }); this.sizes.delete(key); }
        catch { this.sizes.set(key, this.repositoryLimit); }
      }
      finally {
        this.active.delete(key); unlock();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    };
    try {
      if (this.closed || signal?.aborted) throw new GitError('IMPORT_CANCELLED');
      // Reserve the full per-repository allowance before the first await.
      this.active.add(key);
      this.sizes.set(key, this.repositoryLimit);
      if ([...this.sizes.values()].reduce((a, b) => a + b, 0) > this.totalLimit) {
        const candidates = await Promise.all([...this.sizes.keys()].filter((id) => !this.active.has(id) && !this.tails.has(id))
          .map(async (id) => ({ id, time: (await stat(path.join(this.root, id))).mtimeMs })));
        for (const { id } of candidates.sort((a, b) => a.time - b.time)) {
          if (this.active.has(id) || this.tails.has(id)) continue;
          // Reserve deletion synchronously so another acquire cannot use it.
          this.active.add(id);
          const deletion = rm(path.join(this.root, id), { recursive: true, force: true });
          const deleting = deletion.catch(() => undefined);
          this.tails.set(id, deleting);
          try { await deletion; this.sizes.delete(id); }
          finally { this.active.delete(id); if (this.tails.get(id) === deleting) this.tails.delete(id); }
          if ([...this.sizes.values()].reduce((a, b) => a + b, 0) <= this.totalLimit) break;
        }
      }
      if ([...this.sizes.values()].reduce((a, b) => a + b, 0) > this.totalLimit) throw new GitError('GIT_QUOTA_EXCEEDED');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new GitError('UNSAFE_PROJECT_PATH');
      return { directory, release, checkBytes: (bytes) => {
        if (bytes > this.repositoryLimit) throw new GitError('GIT_QUOTA_EXCEEDED');
      } };
    } catch (error) { await release(); throw error; }
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.all(this.tails.values());
      await this.lock.close();
      if (this.temporary) await rm(this.root, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
