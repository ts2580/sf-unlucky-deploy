import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import { SfudError } from '../core/errors.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const MAX_ARTIFACT_OUTPUT_BYTES = 128 * 1024 * 1024;

export async function writeCompressedJsonArtifact(
  runDirectory: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]*\.json\.gz$/u.test(fileName)) {
    throw new SfudError('FILESYSTEM_ERROR', 'artifact 파일 이름이 올바르지 않습니다.');
  }
  const root = path.resolve(runDirectory);
  const artifactDirectory = path.join(root, 'artifacts');
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
  const [realRoot, realArtifactDirectory] = await Promise.all([
    realpath(root),
    realpath(artifactDirectory),
  ]);
  assertContained(realRoot, realArtifactDirectory);

  const targetPath = path.join(realArtifactDirectory, fileName);
  await rejectSymbolicLink(targetPath);
  const temporaryPath = path.join(realArtifactDirectory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(value)), { level: 6 });
    await writeFile(temporaryPath, compressed, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return targetPath;
}

export async function readCompressedJsonArtifact<T>(
  runDirectory: string,
  artifactPath: string,
): Promise<T> {
  const [root, target] = await Promise.all([
    realpath(runDirectory),
    realpath(artifactPath),
  ]);
  assertContained(root, target);
  const compressed = await readFile(target);
  const contents = await gunzipAsync(compressed, { maxOutputLength: MAX_ARTIFACT_OUTPUT_BYTES });
  return JSON.parse(contents.toString('utf8')) as T;
}

function assertContained(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.length === 0 || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SfudError('FILESYSTEM_ERROR', 'artifact 경로가 실행 디렉터리 밖을 가리킵니다.');
  }
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new SfudError('FILESYSTEM_ERROR', 'artifact 심볼릭 링크는 사용할 수 없습니다.');
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
