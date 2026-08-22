import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SfudError } from './errors.js';

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function ensureEmptyDirectory(targetPath: string): Promise<void> {
  if (await pathExists(targetPath)) {
    const entries = await readdir(targetPath);
    if (entries.length > 0) {
      throw new SfudError(
        'FILESYSTEM_ERROR',
        `기존 파일을 덮어쓰지 않도록 비어 있지 않은 디렉터리 사용을 중단했습니다: ${targetPath}`,
      );
    }
  }

  await mkdir(targetPath, { recursive: true });
}

export async function listFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(rootPath, absolutePath).split(path.sep).join('/'));
      }
    }
  }

  await visit(rootPath);
  return files;
}

export async function findPackageRoot(searchRoot: string): Promise<string> {
  const candidates = (await listFiles(searchRoot)).filter(
    (relativePath) => path.posix.basename(relativePath) === 'package.xml',
  );

  if (candidates.length !== 1) {
    throw new SfudError(
      'SNAPSHOT_FAILED',
      `staging 결과에서 package.xml을 하나만 찾을 수 있어야 합니다. 발견 개수: ${candidates.length}`,
    );
  }

  return path.dirname(path.join(searchRoot, candidates[0]!));
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function sha256Directory(rootPath: string): Promise<string> {
  const hash = createHash('sha256');

  for (const relativePath of await listFiles(rootPath)) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await readFile(path.join(rootPath, relativePath)));
    hash.update('\0');
  }

  return hash.digest('hex');
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
