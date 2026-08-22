import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { parseSourceSpec } from '../src/sources/source-spec.js';
import { createSnapshot } from '../src/sources/snapshot.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('metadata snapshot', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('local source를 Metadata API staging으로 변환한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-snapshot-'));
    temporaryDirectories.push(root);
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, 'sfdx-project.json'), '{}\n');
    const manifestPath = path.join(root, 'package.xml');
    await writeFile(manifestPath, '<Package/>\n');
    const client = new FixtureSfClient();

    const snapshot = await createSnapshot({
      source: parseSourceSpec(`local:${projectPath}`),
      manifestPath,
      outputDir: path.join(root, 'snapshot'),
      commandProjectPath: projectPath,
      sfClient: client,
    });

    expect(snapshot.packageRoot).toBe(path.join(root, 'snapshot', 'raw'));
    expect(snapshot.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(client.calls[0]?.args).toContain('convert');
    expect(client.calls[0]?.options.cwd).toBe(projectPath);
  });
});

class FixtureSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    const outputDirectory = flagValue(args, '--output-dir');
    await writeFixtureFiles(outputDirectory, {
      'package.xml': '<Package/>\n',
      'classes/Hello.cls': 'public class Hello {}\n',
    });
    return { status: 0 };
  }
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`${flag} argument missing`);
  }
  return value;
}
