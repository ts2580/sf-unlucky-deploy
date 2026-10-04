import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, lstat, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Ignore } from 'ignore';
import { GitError } from './git-errors.js';
import type { GitObjectReader, GitTreeEntry } from './git-object-store.js';
import { gitMetadataTypes } from '../api/git-metadata-types.js';
import { discoverGitProjects, selectedGitEntries, validateGitProjectConfiguration } from './git-project-validator.js';
import { gitPackageDirectories, metadataGitEntries } from './git-metadata-selection.js';

const createIgnore = createRequire(import.meta.url)('ignore') as () => Ignore;

export interface GitMaterializeOptions {
  metadataType?: string;
  signal?: AbortSignal;
  maximumFiles?: number;
  maximumFileBytes?: number;
  maximumProjectBytes?: number;
  onBytes?: (bytes: number) => void;
}

export class GitMaterializer {
  public constructor(private readonly objects: GitObjectReader) {}

  public async discover(commit: string, signal?: AbortSignal): Promise<string[]> {
    return discoverGitProjects(await this.objects.listTree(commit, signal));
  }

  public async materialize(commit: string, projectRoot: string, destination: string,
    options: GitMaterializeOptions = {}): Promise<{ checksum: string; fileCount: number; sizeBytes: number; manifests: string[] }> {
    const maximumFiles = options.maximumFiles ?? Number.MAX_SAFE_INTEGER;
    const maximumFileBytes = options.maximumFileBytes ?? 10 * 1024 * 1024;
    const maximumProjectBytes = options.maximumProjectBytes ?? 100 * 1024 * 1024;
    if (![maximumFiles, maximumFileBytes, maximumProjectBytes].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new GitError('GIT_QUOTA_EXCEEDED');
    }
    const tree = await this.objects.listTree(commit, options.signal);
    if (!discoverGitProjects(tree).includes(projectRoot)) throw new GitError('DX_PROJECT_NOT_FOUND');
    let entries = selectedGitEntries(tree, projectRoot, options.metadataType !== undefined)
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const configEntry = entries.find((entry) => entry.path === 'sfdx-project.json');
    if (configEntry === undefined) throw new GitError('DX_PROJECT_NOT_FOUND');
    if (configEntry.size > 256 * 1024) throw new GitError('GIT_QUOTA_EXCEEDED');
    const config = await this.objects.readBlob(configEntry.objectId, 256 * 1024, options.signal);
    validateGitProjectConfiguration(config, entries);
    const packages = gitPackageDirectories(config);
    if (options.metadataType !== undefined) entries = metadataGitEntries(entries, packages, options.metadataType);
    if (entries.some((entry) => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
      throw new GitError('UNSUPPORTED_SOURCE_FEATURE');
    }
    if (entries.length > maximumFiles) throw new GitError('GIT_QUOTA_EXCEEDED');
    let expectedBytes = 0;
    for (const entry of entries) {
      expectedBytes += Math.max(0, entry.size);
      if (entry.size > maximumFileBytes || expectedBytes > maximumProjectBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
    }
    await this.objects.prepareBlobs?.(entries.map((entry) => entry.objectId), options.signal);
    const forceignore = entries.find((entry) => entry.path === '.forceignore');
    const ignored = createIgnore().add(['**/.*', '**/*.dup']);
    if (forceignore !== undefined) ignored.add((await this.objects.readBlob(forceignore.objectId, maximumFileBytes, options.signal)).toString('utf8'));
    const outputs = flattenedApexEntries(entries, packages, (file) => ignored.ignores(file));
    if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
    // An exclusive new directory makes cleanup safe and prevents preexisting links.
    const restored = this.objects.restoreFiles !== undefined;
    await mkdir(destination, { mode: 0o700 });
    try {
      if (restored) await this.objects.restoreFiles!(commit, projectRoot, entries, destination, maximumFileBytes, maximumProjectBytes, options.signal);
      for (const directory of packages) await mkdir(path.join(destination, directory), { recursive: true, mode: 0o700 });
      let sizeBytes = 0;
      const hash = createHash('sha256');
      const manifests: string[] = [];
      for (const { entry, outputPath } of outputs) {
        if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
        const original = path.join(destination, ...entry.path.split('/'));
        const target = path.join(destination, ...outputPath.split('/'));
        if (restored) {
          const stat = await lstat(original);
          if (!stat.isFile() || stat.size > maximumFileBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
        }
        const content = restored ? await readFile(original)
          : entry === configEntry ? config : await this.objects.readBlob(entry.objectId, maximumFileBytes, options.signal);
        if (restored && createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !== entry.objectId) {
          throw new GitError('INVALID_GIT_OBJECT');
        }
        if (entry.size >= 0 && content.length !== entry.size) throw new GitError('INVALID_GIT_OBJECT');
        if (content.length > maximumFileBytes || sizeBytes + content.length > maximumProjectBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
        if (content.subarray(0, 1024).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) {
          throw new GitError('UNSUPPORTED_SOURCE_FEATURE');
        }
        options.onBytes?.(content.length);
        if (restored && outputPath === entry.path) await chmod(target, 0o600);
        else {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { flag: 'wx', mode: 0o600 });
          if (restored) await unlink(original);
        }
        hash.update(outputPath); hash.update('\0'); hash.update(String(content.length)); hash.update('\0'); hash.update(content);
        sizeBytes += content.length;
        if (entry.path.startsWith('manifest/') && entry.path.toLowerCase().endsWith('.xml')) manifests.push(entry.path);
      }
      if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
      return { checksum: hash.digest('hex'), fileCount: entries.length, sizeBytes, manifests };
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}

// Normalize only the isolated Git working copy. Keep original tree paths and
// object IDs for restore/verification, but hash the actual comparison payload.
function flattenedApexEntries(entries: GitTreeEntry[], packages: string[], ignored: (file: string) => boolean): Array<{ entry: GitTreeEntry; outputPath: string }> {
  const metadataDirectories = new Set(gitMetadataTypes.map((type) => type.directoryName));
  const packageRoots = [...packages].sort((a, b) => b.length - a.length);
  const classOrigins = new Map<string, string>();
  const outputs = entries.map((entry) => {
    let outputPath = entry.path;
    // Moving an ignored folder's contents would bypass the original ignore rule.
    if (ignored(entry.path)) return { entry, outputPath };
    for (const directory of packageRoots) {
      const prefix = directory === '.' ? '' : `${directory}/`;
      if (!entry.path.startsWith(prefix)) continue;
      const parts = entry.path.slice(prefix.length).split('/');
      const index = parts.findIndex((part) => metadataDirectories.has(part));
      const filename = parts.at(-1)!;
      if (parts[index] !== 'classes' || index === parts.length - 1 || !/\.cls(?:-meta\.xml)?$/u.test(filename)) continue;
      const className = filename.replace(/\.cls(?:-meta\.xml)?$/u, '');
      const origin = entry.path.replace(/\.cls(?:-meta\.xml)?$/u, '');
      const key = className.normalize('NFC').toLowerCase();
      const previous = classOrigins.get(key);
      if (previous !== undefined && previous !== origin) throw new GitError('APEX_PATH_COLLISION');
      classOrigins.set(key, origin);
      outputPath = prefix + [...parts.slice(0, index + 1), filename].join('/');
      break;
    }
    return { entry, outputPath };
  });
  // Reuse the path guard for destination file/directory and Windows collisions.
  selectedGitEntries(outputs.map(({ entry, outputPath }) => ({ ...entry, path: outputPath })), '.');
  return outputs.sort((a, b) => a.outputPath < b.outputPath ? -1 : a.outputPath > b.outputPath ? 1 : 0);
}
