import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git-errors.js';
import type { GitObjectReader } from './git-object-store.js';
import { discoverGitProjects, selectedGitEntries, validateGitProjectConfiguration } from './git-project-validator.js';
import { gitPackageDirectories, metadataGitEntries } from './git-metadata-selection.js';

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
      for (const entry of entries) {
        if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
        const target = path.join(destination, ...entry.path.split('/'));
        if (restored) {
          const stat = await lstat(target);
          if (!stat.isFile() || stat.size > maximumFileBytes) throw new GitError('GIT_QUOTA_EXCEEDED');
        }
        const content = restored ? await readFile(target)
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
        if (restored) await chmod(target, 0o600);
        else {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { flag: 'wx', mode: 0o600 });
        }
        hash.update(entry.path); hash.update('\0'); hash.update(String(content.length)); hash.update('\0'); hash.update(content);
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
