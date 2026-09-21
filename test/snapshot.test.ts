import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { ProcessSfClient } from '../src/salesforce/sf-client.js';
import { parseSourceSpec } from '../src/sources/source-spec.js';
import { createSnapshot } from '../src/sources/snapshot.js';
import { sha256DirectoryV2 } from '../src/core/files.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('metadata snapshot', () => {
  const temporaryDirectories: string[] = [];
  const hasSalesforceCli = spawnSync('sf', ['--version'], { stdio: 'ignore' }).status === 0;

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
    expect(snapshot.payloadDigestVersion).toBe(2);
    expect(client.calls[0]?.args).toContain('convert');
    expect(client.calls[0]?.options.cwd).toBe(projectPath);
  });

  it('v2 payload digest는 경로·바이트 길이·본문 변경을 구분하고 심볼릭 링크를 거부한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-payload-v2-'));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, 'one.txt'), 'same');
    const initial = await sha256DirectoryV2(root);
    await writeFile(path.join(root, 'one.txt'), 'same!');
    expect(await sha256DirectoryV2(root)).not.toBe(initial);
    await writeFile(path.join(root, 'other.txt'), 'same!');
    expect(await sha256DirectoryV2(root)).not.toBe(initial);
    if (process.platform !== 'win32') {
      await symlink('one.txt', path.join(root, 'linked.txt'));
      await expect(sha256DirectoryV2(root)).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' });
    }
  });

  it('run artifact가 프로젝트 .forceignore 아래에 있어도 변환 파일을 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-snapshot-ignore-'));
    temporaryDirectories.push(root);
    const projectPath = path.join(root, 'project');
    await mkdir(projectPath);
    await writeFile(path.join(projectPath, 'sfdx-project.json'), '{}\n');
    await writeFile(path.join(projectPath, '.forceignore'), '.sfud/**\n');
    const manifestPath = path.join(root, 'package.xml');
    await writeFile(manifestPath, '<Package/>\n');
    const client = new FixtureSfClient();

    const snapshot = await createSnapshot({
      source: parseSourceSpec(`local:${projectPath}`),
      manifestPath,
      outputDir: path.join(projectPath, '.sfud', 'runs', 'right'),
      commandProjectPath: projectPath,
      sfClient: client,
    });

    const conversionOutput = flagValue(client.calls[0]?.args ?? [], '--output-dir');
    expect(conversionOutput.startsWith(path.join(projectPath, '.sfud'))).toBe(false);
    expect(await readFile(path.join(snapshot.packageRoot, 'classes/Hello.cls'), 'utf8'))
      .toBe('public class Hello {}\n');
  });

  it.skipIf(!hasSalesforceCli)('실제 Salesforce CLI도 .sfud 출력 필터링을 우회해 클래스 파일을 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-snapshot-cli-'));
    temporaryDirectories.push(root);
    const projectPath = path.join(root, 'project');
    await mkdir(path.join(projectPath, 'force-app/main/default/classes'), { recursive: true });
    await writeFixtureFiles(projectPath, {
      'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '65.0' }),
      '.forceignore': '.sfud/**\n',
      'force-app/main/default/classes/Hello.cls': 'public class Hello {}\n',
      'force-app/main/default/classes/Hello.cls-meta.xml': '<ApexClass><apiVersion>65.0</apiVersion><status>Active</status></ApexClass>\n',
    });
    const manifestPath = path.join(root, 'package.xml');
    await writeFile(manifestPath, '<?xml version="1.0"?><Package><types><members>Hello</members><name>ApexClass</name></types><version>65.0</version></Package>\n');
    const snapshot = await createSnapshot({
      source: parseSourceSpec(`local:${projectPath}`), manifestPath,
      outputDir: path.join(projectPath, '.sfud', 'runs', 'right'), commandProjectPath: projectPath,
      sfClient: new ProcessSfClient('sf'),
    });
    await expect(readFile(path.join(snapshot.packageRoot, 'classes/Hello.cls'), 'utf8'))
      .resolves.toBe('public class Hello {}\n');
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
