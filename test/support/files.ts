import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeFixtureFiles(
  root: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

export async function removeDirectoriesAfterTest(directories: string[]): Promise<void> {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
}
