import { GitError } from './git-errors.js';

export function normalizeGitAlias(value: string): string | null {
  if (typeof value !== 'string' || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitError('INVALID_GIT_ALIAS');
  }
  return value.trim() || null;
}
