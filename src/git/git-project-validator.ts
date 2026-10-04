import path from 'node:path';
import { GitError } from './git-errors.js';
import type { GitTreeEntry } from './git-object-store.js';

const excludedDirectories = new Set(['.git', '.sf', '.sfdx', 'node_modules']);

export function safeGitPath(value: string, allowRoot = false): string {
  if (allowRoot && value === '.') return value;
  if (value.length === 0 || value.length > 1024 || value.startsWith('/')
    || /[\u0000-\u001f\u007f<>:"|?*\\]/u.test(value)) throw new GitError('UNSAFE_PROJECT_PATH');
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || /[. ]$/u.test(segment)
      || Buffer.byteLength(segment) > 255 || /~\d/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(segment)) {
      throw new GitError('UNSAFE_PROJECT_PATH');
    }
  }
  return value;
}

function excludedGitPath(value: string): boolean {
  return value.split('/').some((segment) => {
    const lower = segment.toLowerCase();
    return excludedDirectories.has(lower) || lower === '.env' || lower.startsWith('.env.')
      || /\.(?:key|pem|p12|pfx)$/u.test(lower) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/u.test(lower);
  });
}

export function discoverGitProjects(entries: readonly GitTreeEntry[], maximumDepth = 10): string[] {
  const roots = new Set<string>();
  for (const entry of entries) {
    if (path.posix.basename(entry.path) !== 'sfdx-project.json' || excludedGitPath(entry.path)) continue;
    safeGitPath(entry.path);
    if (entry.path.split('/').length - 1 > maximumDepth) throw new GitError('GIT_QUOTA_EXCEEDED');
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new GitError('UNSUPPORTED_SOURCE_FEATURE');
    roots.add(path.posix.dirname(entry.path));
  }
  if (roots.size === 0) throw new GitError('DX_PROJECT_NOT_FOUND');
  return [...roots].sort();
}

export function selectedGitEntries(entries: readonly GitTreeEntry[], root: string, deferFileValidation = false): GitTreeEntry[] {
  safeGitPath(root, true);
  const prefix = root === '.' ? '' : `${root}/`;
  const selected = entries.filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
  const names = new Map<string, { name: string; file: boolean }>();
  for (const entry of selected) {
    safeGitPath(entry.path);
    // Validate collisions even for filtered files so extraction is platform-independent.
    const segments = entry.path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const name = segments.slice(0, index).join('/');
      const canonical = name.normalize('NFC').toLowerCase();
      const file = index === segments.length;
      const prior = names.get(canonical);
      if (prior !== undefined && (prior.name !== name || prior.file || file)) throw new GitError('UNSAFE_PROJECT_PATH');
      names.set(canonical, { name, file });
    }
    if (!deferFileValidation && !excludedGitPath(entry.path) && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
      throw new GitError('UNSUPPORTED_SOURCE_FEATURE');
    }
  }
  return selected.filter((entry) => !excludedGitPath(entry.path));
}

export function validateGitProjectConfiguration(content: Buffer, entries: readonly GitTreeEntry[]): void {
  if (content.length > 256 * 1024) throw new GitError('GIT_QUOTA_EXCEEDED');
  let configuration: unknown;
  try { configuration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
  catch { throw new GitError('DX_PROJECT_NOT_FOUND'); }
  if (typeof configuration !== 'object' || configuration === null || !('packageDirectories' in configuration)
    || !Array.isArray(configuration.packageDirectories) || configuration.packageDirectories.length === 0
    || configuration.packageDirectories.length > 100) throw new GitError('DX_PROJECT_NOT_FOUND');
  for (const pkg of configuration.packageDirectories as unknown[]) {
    if (typeof pkg !== 'object' || pkg === null || !('path' in pkg) || typeof pkg.path !== 'string') {
      throw new GitError('UNSAFE_PROJECT_PATH');
    }
    const directory = safeGitPath(pkg.path, true);
    if (excludedGitPath(directory) || (directory !== '.' && !entries.some((entry) => entry.path.startsWith(`${directory}/`)))) {
      throw new GitError('UNSAFE_PROJECT_PATH');
    }
  }
  // The metadata conversion command receives only this source directory. Remote
  // package dependencies/scripts in the DX configuration are never installed.
}
