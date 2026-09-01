import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCompareCommand } from '../src/commands/compare.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('compare command', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('두 org snapshot을 비교하고 모든 리포트를 생성한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-compare-command-'));
    temporaryDirectories.push(root);
    const manifestPath = path.join(root, 'package.xml');
    await writeFile(manifestPath, '<Package/>\n');
    const output: string[] = [];
    const client = new OrgCompareSfClient();

    const result = await runCompareCommand(
      {
        left: 'org:left',
        right: 'org:right',
        manifest: manifestPath,
        reportDir: path.join(root, 'run'),
        failOnDiff: true,
        detail: true,
        color: false,
      },
      { cwd: process.cwd(), sfClient: client, stdout: (value) => output.push(value) },
    );

    expect(result.exitCode).toBe(1);
    expect(result.comparison.summary.modified).toBe(1);
    expect(client.calls.filter((call) => call.args.includes('retrieve'))).toHaveLength(2);
    for (const call of client.calls.filter((entry) => entry.args.includes('retrieve'))) {
      expect(flagValue(call.args, '--wait')).toBe('60');
      expect(call.options.timeoutMs).toBe(61 * 60 * 1000);
    }
    const requestWorkspaces = new Set(client.calls.map((call) => call.options.cwd));
    expect(requestWorkspaces.size).toBe(1);
    const requestWorkspace = [...requestWorkspaces][0]!;
    expect(path.basename(requestWorkspace)).toMatch(/^sfud-request-/u);
    await expect(access(requestWorkspace)).rejects.toThrow();
    expect(output.join('')).toContain("return 'right'");
    await Promise.all([
      access(result.reports.markdown),
      access(result.reports.json),
      access(result.reports.diff),
      access(result.reports.html),
      access(result.reports.checksums),
    ]);
  });

  it('선택 타입 멤버가 양쪽 모두 없으면 retrieve 없이 0개 차이로 완료한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-empty-compare-'));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '67.0',
    }));
    const client = new EmptyDynamicCompareSfClient();

    const result = await runCompareCommand({
      left: 'org:left',
      right: 'org:right',
      metadataType: 'ApexClass',
      reportDir: path.join(root, 'run'),
      color: false,
    }, { cwd: root, sfClient: client, stdout: () => undefined });

    expect(result.comparison.summary).toEqual({
      added: 0, removed: 0, modified: 0, identical: 0, total: 0, different: 0,
    });
    expect(client.calls.filter((args) => args.includes('retrieve'))).toHaveLength(0);
    expect(client.calls.filter((args) => args.includes('manifest'))).toHaveLength(2);
  });

  it('동적 비교는 합집합 범위를 유지하면서 각 source manifest로 retrieve한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-source-scoped-compare-'));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '67.0',
    }));
    const client = new SourceScopedDynamicCompareSfClient();

    const result = await runCompareCommand({
      left: 'org:left',
      right: 'org:right',
      metadataType: 'ApexClass',
      wait: 90,
      reportDir: path.join(root, 'run'),
      color: false,
    }, { cwd: root, sfClient: client, stdout: () => undefined });

    expect(result.comparison.summary).toMatchObject({ added: 1, removed: 1, total: 2, different: 2 });
    expect(client.retrievals).toHaveLength(2);
    const leftRetrieval = client.retrievals.find((entry) => entry.alias === 'left')!;
    const rightRetrieval = client.retrievals.find((entry) => entry.alias === 'right')!;
    for (const retrieval of client.retrievals) {
      expect(retrieval.waitMinutes).toBe('90');
      expect(retrieval.options.timeoutMs).toBe(91 * 60 * 1000);
    }
    expect(leftRetrieval.manifestPath).not.toBe(rightRetrieval.manifestPath);
    await expect(readFile(leftRetrieval.manifestPath, 'utf8')).resolves.toContain('<members>leftOnly</members>');
    await expect(readFile(leftRetrieval.manifestPath, 'utf8')).resolves.not.toContain('rightOnly');
    await expect(readFile(rightRetrieval.manifestPath, 'utf8')).resolves.toContain('<members>rightOnly</members>');
    await expect(readFile(rightRetrieval.manifestPath, 'utf8')).resolves.not.toContain('leftOnly');
    expect(result.comparison.left.manifestSha256).toBe(result.comparison.right.manifestSha256);
  });
});

class SourceScopedDynamicCompareSfClient implements SfClient {
  public readonly retrievals: Array<{
    alias: string;
    manifestPath: string;
    options: SfRunOptions;
    waitMinutes: string;
  }> = [];

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { result: { metadataObjects: [
        { directoryName: 'classes', suffix: 'cls', xmlName: 'ApexClass' },
      ] } };
    }
    if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
      const alias = flagValue(args, '--from-org');
      const outputDirectory = flagValue(args, '--output-dir');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, flagValue(args, '--name')), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        `  <types><members>${alias}Only</members><name>ApexClass</name></types>`,
        '  <version>67.0</version>',
        '</Package>',
      ].join('\n'));
      return { status: 0 };
    }
    if (args[0] === 'project' && args[1] === 'retrieve') {
      const alias = flagValue(args, '--target-org');
      const manifestPath = flagValue(args, '--manifest');
      this.retrievals.push({ alias, manifestPath, options, waitMinutes: flagValue(args, '--wait') });
      await writeFixtureFiles(flagValue(args, '--target-metadata-dir'), {
        'unpackaged/package.xml': '<Package/>\n',
        [`unpackaged/classes/${alias}Only.cls`]: `public class ${alias}Only {}\n`,
        [`unpackaged/classes/${alias}Only.cls-meta.xml`]: '<ApexClass/>\n',
      });
      return { status: 0 };
    }
    throw new Error(`지원하지 않는 테스트 명령: ${args.join(' ')}`);
  }
}

class EmptyDynamicCompareSfClient implements SfClient {
  public readonly calls: string[][] = [];

  public async runJson(args: readonly string[], _options: SfRunOptions): Promise<unknown> {
    this.calls.push([...args]);
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { result: { metadataObjects: [
        { directoryName: 'classes', suffix: 'cls', xmlName: 'ApexClass' },
      ] } };
    }
    if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
      await writeFile(path.join(flagValue(args, '--output-dir'), flagValue(args, '--name')), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
        '  <version>67.0</version>',
        '</Package>',
      ].join('\n'));
      return { status: 0 };
    }
    throw new Error(`빈 manifest 비교에서 실행되면 안 되는 명령: ${args.join(' ')}`);
  }
}

class OrgCompareSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    const targetAlias = flagValue(args, '--target-org');
    const outputDirectory = flagValue(args, '--target-metadata-dir');
    await writeFixtureFiles(outputDirectory, {
      'package.xml': '<Package/>\n',
      'classes/Hello.cls': `public class Hello { String value() { return '${targetAlias}'; } }\n`,
      'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
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
