import { gitMetadataTypes, type GitMetadataType } from '../api/git-metadata-types.js';
import { GitError } from './git-errors.js';
import type { GitTreeEntry } from './git-object-store.js';

export function requireGitMetadataType(name: string): GitMetadataType {
  const type = gitMetadataTypes.find((entry) => entry.name === name);
  if (type === undefined) throw new GitError('UNSUPPORTED_METADATA_TYPE');
  return type;
}

// Configuration has already passed validateGitProjectConfiguration. Retain the
// original config, and create even empty package directories for SF conversion.
export function gitPackageDirectories(configuration: Buffer): string[] {
  return (JSON.parse(configuration.toString('utf8')) as { packageDirectories: { path: string }[] })
    .packageDirectories.map((entry) => entry.path);
}

export function metadataGitEntries(entries: GitTreeEntry[], packages: string[], name: string): GitTreeEntry[] {
  const type = requireGitMetadataType(name);
  return entries.filter((entry) => {
    if (entry.path === 'sfdx-project.json' || entry.path === '.forceignore') return true;
    return packages.some((directory) => {
      const prefix = directory === '.' ? '' : `${directory}/`;
      if (!entry.path.startsWith(prefix)) return false;
      const parts = entry.path.slice(prefix.length).split('/');
      // DX permits custom package layouts (not only force-app/main/default).
      const index = parts.indexOf(type.directoryName);
      if (index < 0 || index === parts.length - 1) return false;
      if (type.childDirectory === undefined) return true;
      const withinType = parts.slice(index + 1);
      // Decomposed children need the parent descriptor as conversion context.
      return (withinType.length >= 3 && withinType[1] === type.childDirectory)
        || (withinType.length === 2 && withinType[1] === `${withinType[0]}.object-meta.xml`)
        || (withinType.length === 1 && withinType[0]!.endsWith('.object-meta.xml'));
    });
  });
}
