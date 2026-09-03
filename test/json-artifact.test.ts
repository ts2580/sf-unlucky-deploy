import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readCompressedJsonArtifact,
  writeCompressedJsonArtifact,
} from '../src/storage/json-artifact.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('compressed JSON artifact', () => {
  it('실행 디렉터리 안에 0600으로 저장하고 원래 JSON을 복원한다', async () => {
    const root = await temporaryRoot();
    const value = { status: 'Succeeded', details: 'x'.repeat(16_384) };

    const artifactPath = await writeCompressedJsonArtifact(root, 'deployment.json.gz', value);

    expect((await stat(path.dirname(artifactPath))).mode & 0o777).toBe(0o700);
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    expect((await stat(artifactPath)).size).toBeLessThan(JSON.stringify(value).length);
    await expect(readCompressedJsonArtifact(root, artifactPath)).resolves.toEqual(value);
  });

  it('다른 실행 디렉터리의 artifact 읽기를 거부한다', async () => {
    const expectedRoot = await temporaryRoot();
    const otherRoot = await temporaryRoot();
    const outsidePath = await writeCompressedJsonArtifact(otherRoot, 'comparison.json.gz', { safe: true });

    await expect(readCompressedJsonArtifact(expectedRoot, outsidePath)).rejects.toThrow(/밖을 가리킵니다/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-json-artifact-'));
  roots.push(root);
  return root;
}
