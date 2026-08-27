import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDeployCommand } from '../src/commands/deploy.js';
import { SfudError } from '../src/core/errors.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('deploy command', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('기본 동작은 dry-run 한 번만 실행한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient();

    const result = await runDeployCommand(
      {
        from: `local:${fixture.projectPath}`,
        to: 'target',
        manifest: fixture.manifestPath,
        reportDir: fixture.runDirectory,
        color: false,
      },
      { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
    );

    expect(result.executed).toBe(false);
    const deployCalls = client.calls.filter((call) => call.args.includes('deploy'));
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0]?.args).toContain('--dry-run');
    expect(deployCalls[0]?.args).not.toContain('--single-package');
    expect(deployCalls[0]?.args).toEqual(
      expect.arrayContaining(['--test-level', 'RunSpecifiedTests', '--tests', 'Hello_Test']),
    );
    const retrieveCall = client.calls.find((call) => call.args.includes('retrieve'))!;
    expect(deployCalls[0]!.options.cwd).toBe(retrieveCall.options.cwd);
    expect(path.basename(retrieveCall.options.cwd)).toMatch(/^sfud-request-/u);
    await expect(access(retrieveCall.options.cwd)).rejects.toThrow();
    expect(result.testPlan).toEqual({
      level: 'RunSpecifiedTests',
      tests: ['Hello_Test'],
      selection: 'suffix',
    });
    expect(result.dryRunResult).toMatchObject({ result: { accessToken: '[REDACTED]' } });
    await expect(readFile(path.join(fixture.runDirectory, 'logs', 'dry-run.json'), 'utf8')).resolves.not.toContain(
      'must-not-leak',
    );
  });

  it('배포 비교는 target에서 desired source 방향으로 추가 항목을 표시한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient(false, null);

    const result = await runDeployCommand(
      {
        from: `local:${fixture.projectPath}`,
        to: 'target',
        manifest: fixture.manifestPath,
        reportDir: fixture.runDirectory,
        dryRun: true,
        color: false,
      },
      { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
    );

    expect(result.comparison.summary).toMatchObject({ added: 2, removed: 0 });
    expect(result.comparison.components.map((component) => component.status)).toEqual(['ADDED', 'ADDED']);
  });

  it('--execute면 dry-run 성공 후 동일 payload를 실제 배포한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient();

    const result = await runDeployCommand(
      {
        from: `local:${fixture.projectPath}`,
        to: 'target',
        manifest: fixture.manifestPath,
        reportDir: fixture.runDirectory,
        execute: true,
        color: false,
      },
      { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
    );

    expect(result.executed).toBe(true);
    const deployCalls = client.calls.filter((call) => call.args.includes('deploy'));
    expect(deployCalls).toHaveLength(2);
    expect(deployCalls[0]?.args).toContain('--dry-run');
    expect(deployCalls[1]?.args).not.toContain('--dry-run');
  });

  it('source와 target이 동일해도 요청한 dry-run 검증은 실행한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient(false, 'source');

    const result = await runDeployCommand(
      {
        from: `local:${fixture.projectPath}`,
        to: 'target',
        manifest: fixture.manifestPath,
        reportDir: fixture.runDirectory,
        dryRun: true,
        color: false,
      },
      { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
    );

    expect(result.comparison.summary.different).toBe(0);
    expect(client.calls.filter((call) => call.args.includes('deploy'))).toHaveLength(1);
  });

  it('전체 metadata 비교 합집합과 배포 source manifest를 분리한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    await writeFile(path.join(fixture.projectPath, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '67.0',
    }));
    await mkdir(path.join(fixture.projectPath, 'force-app'), { recursive: true });
    const client = new DeployablePayloadSfClient();

    const result = await runDeployCommand({
      from: `local:${fixture.projectPath}`,
      to: 'target',
      allMetadata: true,
      reportDir: fixture.runDirectory,
      dryRun: true,
      color: false,
    }, { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined });

    expect(result.comparison.summary).toMatchObject({ added: 1, removed: 1 });
    expect(client.deployedManifest).toContain('<members>SourceOnly</members>');
    expect(client.deployedManifest).toContain('<members>Shared</members>');
    expect(client.deployedManifest).not.toContain('TargetOnly');
    expect(client.calls.filter((call) => call.args.includes('convert'))).toHaveLength(2);
    expect(result.payloadSha256).not.toBe(result.comparison.right.payloadSha256);
  });

  it('동적 source manifest가 비어 있으면 target-only 비교 후 Salesforce 배포를 생략한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    await writeFile(path.join(fixture.projectPath, 'sfdx-project.json'), JSON.stringify({
      packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '67.0',
    }));
    await mkdir(path.join(fixture.projectPath, 'force-app'), { recursive: true });
    const client = new DeployablePayloadSfClient([], ['TargetOnly']);

    const result = await runDeployCommand({
      from: `local:${fixture.projectPath}`,
      to: 'target',
      allMetadata: true,
      reportDir: fixture.runDirectory,
      dryRun: true,
      color: false,
    }, { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined });

    expect(result.comparison.summary).toMatchObject({ added: 0, removed: 1 });
    expect(client.calls.filter((call) => call.args.includes('deploy'))).toHaveLength(0);
    expect(result.dryRunResult).toMatchObject({ result: { checkOnly: true, empty: true } });
  });

  it('dry-run 뒤 staging payload가 바뀌면 실제 배포를 차단한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient(true);

    await expect(
      runDeployCommand(
        {
          from: `local:${fixture.projectPath}`,
          to: 'target',
          manifest: fixture.manifestPath,
          reportDir: fixture.runDirectory,
          execute: true,
          color: false,
        },
        { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_CHANGED' } satisfies Partial<SfudError>);

    expect(client.calls.filter((call) => call.args.includes('deploy'))).toHaveLength(1);
  });

  it('--dry-run과 --execute를 동시에 지정하면 실행 전에 거부한다', async () => {
    const fixture = await createDeployFixture(temporaryDirectories);
    const client = new DeployFixtureSfClient();

    await expect(
      runDeployCommand(
        {
          from: `local:${fixture.projectPath}`,
          to: 'target',
          manifest: fixture.manifestPath,
          reportDir: fixture.runDirectory,
          dryRun: true,
          execute: true,
          color: false,
        },
        { cwd: fixture.projectPath, sfClient: client, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(client.calls).toHaveLength(0);
  });
});

class DeployFixtureSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];

  public constructor(
    private readonly mutateAfterDryRun = false,
    private readonly targetValue: string | null = 'target',
  ) {}

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });

    if (args.includes('convert')) {
      await writeSnapshot(flagValue(args, '--output-dir'), 'source');
    } else if (args.includes('retrieve')) {
      await writeSnapshot(flagValue(args, '--target-metadata-dir'), this.targetValue);
    } else if (args.includes('deploy') && args.includes('--dry-run') && this.mutateAfterDryRun) {
      await writeFile(path.join(flagValue(args, '--metadata-dir'), 'classes', 'Hello.cls'), 'changed after dry-run\n');
    }

    return { status: 0, result: { id: '0Af-safe', accessToken: 'must-not-leak' } };
  }
}

class DeployablePayloadSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];
  public deployedManifest = '';

  public constructor(
    private readonly sourceMembers: readonly string[] = ['Shared', 'SourceOnly'],
    private readonly targetMembers: readonly string[] = ['Shared', 'TargetOnly'],
  ) {}

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { result: { metadataObjects: [
        { directoryName: 'classes', suffix: 'cls', xmlName: 'ApexClass' },
      ] } };
    }
    if (args[0] === 'project' && args[1] === 'generate' && args[2] === 'manifest') {
      const members = args.includes('--from-org') ? this.targetMembers : this.sourceMembers;
      await writeFile(
        path.join(flagValue(args, '--output-dir'), flagValue(args, '--name')),
        renderApexManifest(members),
      );
      return { status: 0 };
    }
    if (args.includes('retrieve')) {
      await writeMetadataPackage(
        flagValue(args, '--target-metadata-dir'),
        await readFile(flagValue(args, '--manifest'), 'utf8'),
        this.targetMembers,
      );
      return { status: 0 };
    }
    if (args.includes('convert')) {
      await writeMetadataPackage(
        flagValue(args, '--output-dir'),
        await readFile(flagValue(args, '--manifest'), 'utf8'),
        this.sourceMembers,
      );
      return { status: 0 };
    }
    if (args.includes('deploy')) {
      this.deployedManifest = await readFile(
        path.join(flagValue(args, '--metadata-dir'), 'package.xml'),
        'utf8',
      );
      return { status: 0, result: { id: '0Af-source-only' } };
    }
    throw new Error(`예상하지 못한 sf 명령: ${args.join(' ')}`);
  }
}

async function writeSnapshot(outputDirectory: string, value: string | null): Promise<void> {
  if (value === null) {
    await writeFixtureFiles(outputDirectory, { 'package.xml': '<Package/>\n' });
    return;
  }

  await writeFixtureFiles(outputDirectory, {
    'package.xml': '<Package/>\n',
    'classes/Hello.cls': `public class Hello { String value = '${value}'; }\n`,
    'classes/Hello.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
    'classes/Hello_Test.cls': 'public class Hello_Test {}\n',
    'classes/Hello_Test.cls-meta.xml': '<?xml version="1.0"?><ApexClass><status>Active</status></ApexClass>',
  });
}

async function writeMetadataPackage(
  outputDirectory: string,
  manifest: string,
  members: readonly string[],
): Promise<void> {
  const files: Record<string, string> = { 'package.xml': manifest };
  for (const member of members) {
    files[`classes/${member}.cls`] = `public class ${member} {}\n`;
    files[`classes/${member}.cls-meta.xml`] = '<ApexClass><status>Active</status></ApexClass>\n';
  }
  await writeFixtureFiles(outputDirectory, files);
}

function renderApexManifest(members: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <types>',
    ...members.map((member) => `    <members>${member}</members>`),
    '    <name>ApexClass</name>',
    '  </types>',
    '  <version>67.0</version>',
    '</Package>',
    '',
  ].join('\n');
}

async function createDeployFixture(temporaryDirectories: string[]): Promise<{
  projectPath: string;
  manifestPath: string;
  runDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-deploy-'));
  temporaryDirectories.push(root);
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'sfdx-project.json'), '{}\n');
  const manifestPath = path.join(root, 'package.xml');
  await writeFile(manifestPath, '<Package/>\n');
  return { projectPath, manifestPath, runDirectory: path.join(root, 'run') };
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index < 0 || value === undefined) {
    throw new Error(`${flag} argument missing`);
  }
  return value;
}
