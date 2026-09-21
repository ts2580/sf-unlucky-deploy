import { mkdtemp, mkdir, rename, rm, writeFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git-errors.js';
import { assertCommitSha } from './git-repository.js';
import { runIsolatedGit } from './git-process.js';

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  objectId: string;
  size: number;
}
export interface GitObjectReader {
  restoreFiles?(commit: string, root: string, entries: GitTreeEntry[], destination: string, maximumFileBytes: number, maximumProjectBytes: number, signal?: AbortSignal): Promise<void>;
  prepareBlobs?(objectIds: string[], signal?: AbortSignal): Promise<void>;
  listTree(commit: string, signal?: AbortSignal): Promise<GitTreeEntry[]>;
  readBlob(objectId: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer>;
}

export class GitObjectStore implements GitObjectReader {
  public constructor(private readonly directory: string, private readonly gitDirectory: string,
    private readonly fetchBlobs?: (objectIds: string[], signal?: AbortSignal) => Promise<void>) {}

  public async prepareBlobs(objectIds: string[], signal?: AbortSignal): Promise<void> {
    if (this.fetchBlobs === undefined || objectIds.length === 0) return;
    const unique = [...new Set(objectIds)];
    for (const id of unique) assertCommitSha(id);
    const output = await runIsolatedGit(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      cwd: this.directory, gitDirectory: this.gitDirectory, input: Buffer.from(`${unique.join('\n')}\n`),
      ...(signal === undefined ? {} : { signal }),
    });
    const lines = output.toString('utf8').trimEnd().split('\n');
    if (lines.length !== unique.length) throw new GitError('INVALID_GIT_OBJECT');
    const missing: string[] = [];
    for (const [index, id] of unique.entries()) {
      if (lines[index] === `${id} missing`) missing.push(id);
      else if (lines[index] !== `${id} blob`) throw new GitError('INVALID_GIT_OBJECT');
    }
    // Bound each negotiation while avoiding one network request per file.
    for (let index = 0; index < missing.length; index += 500) await this.fetchBlobs(missing.slice(index, index + 500), signal);
  }

  public async listTree(commit: string, signal?: AbortSignal): Promise<GitTreeEntry[]> {
    assertCommitSha(commit);
    const type = await runIsolatedGit(['cat-file', '-t', commit], {
      cwd: this.directory, gitDirectory: this.gitDirectory, ...(signal === undefined ? {} : { signal }),
    });
    if (type.toString('utf8').trim() !== 'commit') throw new GitError('INVALID_GIT_OBJECT');
    // Asking ls-tree for blob sizes can trigger implicit lazy fetching. Trees
    // alone are enough to select paths; enforce sizes when reading chosen blobs.
    const output = await runIsolatedGit(['ls-tree', '-r', ...(this.fetchBlobs === undefined ? ['-l'] : []), '-z', '--full-tree', commit], {
      cwd: this.directory, gitDirectory: this.gitDirectory, ...(signal === undefined ? {} : { signal }),
    });
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
    catch { throw new GitError('UNSAFE_PROJECT_PATH'); }
    if (text !== '' && !text.endsWith('\0')) throw new GitError('INVALID_GIT_OBJECT');
    return text.split('\0').filter(Boolean).map((line) => {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})(?: +([0-9]+|-))?\t([\s\S]+)$/u.exec(line);
      if (match === null) throw new GitError('INVALID_GIT_OBJECT');
      const size = match[4] === undefined ? -1 : match[4] === '-' ? 0 : Number(match[4]);
      if (!Number.isSafeInteger(size)) throw new GitError('GIT_QUOTA_EXCEEDED');
      return { path: match[5]!, mode: match[1]!, type: match[2] as 'blob' | 'commit', objectId: match[3]!, size };
    });
  }

  public async restoreFiles(commit: string, root: string, entries: GitTreeEntry[], destination: string,
    maximumFileBytes: number, maximumProjectBytes: number, signal?: AbortSignal): Promise<void> {
    await mkdir(path.join(this.gitDirectory, 'info'), { recursive: true });
    await writeFile(path.join(this.gitDirectory, 'info', 'attributes'), '* -text -ident -filter -working-tree-encoding\n', { mode: 0o600 });
    await this.prepareBlobs(entries.map((entry) => entry.objectId), signal);
    const sizes = await runIsolatedGit(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
      cwd: this.directory, gitDirectory: this.gitDirectory,
      input: Buffer.from(`${entries.map((entry) => entry.objectId).join('\n')}\n`),
      ...(signal === undefined ? {} : { signal }),
    });
    const lines = sizes.toString('utf8').trimEnd().split('\n');
    let total = 0;
    if (lines.length !== entries.length) throw new GitError('INVALID_GIT_OBJECT');
    for (const [i, entry] of entries.entries()) {
      const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(lines[i]!);
      if (match?.[1] !== entry.objectId) throw new GitError('INVALID_GIT_OBJECT');
      const size = Number(match[2]);
      total += size;
      if (!Number.isSafeInteger(size) || size > maximumFileBytes || total > maximumProjectBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
    }
    const scratch = await mkdtemp(path.join(path.dirname(destination), '.restore-'));
    const workTree = path.join(scratch, 'tree');
    try {
      await mkdir(workTree, { mode: 0o700 });
      const paths = entries.map((entry) => root === '.' ? entry.path : `${root}/${entry.path}`);
      await runIsolatedGit(['--literal-pathspecs', 'restore', `--source=${commit}`, '--staged', '--worktree',
        '--no-overlay', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: scratch, gitDirectory: this.gitDirectory, workTree, indexFile: path.join(scratch, 'index'),
        input: Buffer.from(`${paths.join('\0')}\0`), ...(signal === undefined ? {} : { signal }),
      });
      await rmdir(destination); // Caller exclusively created this empty destination.
      await rename(root === '.' ? workTree : path.join(workTree, root), destination);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  public async readBlob(objectId: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
    assertCommitSha(objectId);
    await this.prepareBlobs([objectId], signal);
    return runIsolatedGit(['cat-file', 'blob', objectId], {
      cwd: this.directory, gitDirectory: this.gitDirectory, maxOutputBytes: maximumBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
