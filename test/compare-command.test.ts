import { access, mkdtemp, writeFile } from 'node:fs/promises';
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
});

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
