import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { sha256Directory, writeJson } from '../core/files.js';
import {
  selectApexTestPlan,
  type ApexTestPlan,
  type RequestedTestLevel,
} from '../deploy/test-plan.js';
import { compareSnapshots, type ComparisonResult } from '../metadata/comparator.js';
import { renderTerminalReport } from '../reports/terminal.js';
import { writeComparisonReports, type ReportPaths } from '../reports/writer.js';
import {
  ProcessSfClient,
  sanitizeSfOutput,
  type SfClient,
} from '../salesforce/sf-client.js';
import { parseSourceSpec } from '../sources/source-spec.js';
import { createSnapshot } from '../sources/snapshot.js';
import { createRunContext, writeRunMetadata } from './run-context.js';

export interface DeployCommandOptions {
  from: string;
  to: string;
  manifest: string;
  reportDir?: string;
  dryRun?: boolean;
  execute?: boolean;
  testLevel?: RequestedTestLevel;
  tests?: string[];
  wait?: number;
  strict?: boolean;
  json?: boolean;
  color?: boolean;
}

export interface DeployCommandDependencies {
  cwd?: string;
  sfClient?: SfClient;
  stdout?: (value: string) => void;
}

export interface DeployCommandResult {
  comparison: ComparisonResult;
  reports: ReportPaths;
  runDirectory: string;
  dryRunResult?: unknown;
  deployResult?: unknown;
  executed: boolean;
  testPlan: ApexTestPlan;
}

export async function runDeployCommand(
  options: DeployCommandOptions,
  dependencies: DeployCommandDependencies = {},
): Promise<DeployCommandResult> {
  validateDeployOptions(options);
  const cwd = dependencies.cwd ?? process.cwd();
  const sfClient = dependencies.sfClient ?? new ProcessSfClient();
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const manifestPath = path.resolve(cwd, options.manifest);
  const source = parseSourceSpec(options.from, cwd);
  const targetAlias = normalizeTargetAlias(options.to);
  const targetSource = parseSourceSpec(`org:${targetAlias}`, cwd);
  const context = await createRunContext(cwd, options.reportDir, 'deploy');
  await writeRunMetadata(context, 'deploy', source, targetSource.displayName, manifestPath);

  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    createSnapshot({
      source,
      manifestPath,
      outputDir: context.leftSnapshotDirectory,
      commandProjectPath: cwd,
      sfClient,
      waitMinutes: options.wait ?? 60,
    }),
    createSnapshot({
      source: targetSource,
      manifestPath,
      outputDir: context.rightSnapshotDirectory,
      commandProjectPath: cwd,
      sfClient,
      waitMinutes: options.wait ?? 60,
    }),
  ]);

  const comparison = await compareSnapshots(sourceSnapshot, targetSnapshot, {
    strict: options.strict ?? false,
  });
  const testPlan = await selectApexTestPlan(
    sourceSnapshot.packageRoot,
    options.testLevel ?? 'auto',
    options.tests ?? [],
  );
  const reports = await writeComparisonReports(comparison, context.reportDirectory);
  await writeJson(path.join(context.logsDirectory, 'test-plan.json'), testPlan);
  if (!options.json) {
    stdout(
      renderTerminalReport(comparison, {
        detail: true,
        color: options.color ?? process.stdout.isTTY,
      }),
    );
    stdout(`리포트: ${reports.html}\n`);
    stdout(
      `Apex 테스트: ${testPlan.level}${testPlan.tests.length > 0 ? ` (${testPlan.tests.join(', ')})` : ''} [${testPlan.selection}]\n`,
    );
  }

  await assertPayloadUnchanged(sourceSnapshot.packageRoot, sourceSnapshot.payloadSha256);
  const deployArgs = buildDeployArgs(options, sourceSnapshot.packageRoot, targetAlias, testPlan);
  const dryRunResult = sanitizeSfOutput(
    await sfClient.runJson([...deployArgs, '--dry-run'], { cwd }),
  );
  await writeJson(path.join(context.logsDirectory, 'dry-run.json'), dryRunResult);

  let deployResult: unknown;
  if (options.execute) {
    await assertPayloadUnchanged(sourceSnapshot.packageRoot, sourceSnapshot.payloadSha256);
    deployResult = sanitizeSfOutput(await sfClient.runJson(deployArgs, { cwd }));
    await writeJson(path.join(context.logsDirectory, 'deploy.json'), deployResult);
  }

  const result: DeployCommandResult = {
    comparison,
    reports,
    runDirectory: context.rootDirectory,
    dryRunResult,
    ...(deployResult === undefined ? {} : { deployResult }),
    executed: options.execute ?? false,
    testPlan,
  };
  if (!options.json) {
    stdout(options.execute ? 'dry-run 및 실제 배포 완료\n' : 'dry-run 완료 (실제 배포는 실행하지 않음)\n');
  }
  emitJsonIfRequested(options.json, stdout, result);
  return result;
}

function buildDeployArgs(
  options: DeployCommandOptions,
  metadataDirectory: string,
  targetAlias: string,
  testPlan: ApexTestPlan,
): string[] {
  const args = [
    'project',
    'deploy',
    'start',
    '--target-org',
    targetAlias,
    '--metadata-dir',
    metadataDirectory,
    '--single-package',
    '--wait',
    String(options.wait ?? 60),
    '--test-level',
    testPlan.level,
  ];
  for (const testName of testPlan.tests) {
    args.push('--tests', testName);
  }
  return args;
}

function validateDeployOptions(options: DeployCommandOptions): void {
  if (options.dryRun && options.execute) {
    throw new SfudError('INVALID_ARGUMENT', '--dry-run과 --execute는 함께 사용할 수 없습니다.');
  }
  if (options.wait !== undefined && (!Number.isInteger(options.wait) || options.wait < 1)) {
    throw new SfudError('INVALID_ARGUMENT', '--wait는 1 이상의 정수여야 합니다.');
  }
}

async function assertPayloadUnchanged(packageRoot: string, expectedSha256: string): Promise<void> {
  const actualSha256 = await sha256Directory(packageRoot);
  if (actualSha256 !== expectedSha256) {
    throw new SfudError(
      'PAYLOAD_CHANGED',
      `비교 이후 staging payload가 변경되어 배포를 중단했습니다. expected=${expectedSha256} actual=${actualSha256}`,
    );
  }
}

function normalizeTargetAlias(value: string): string {
  const alias = (value.startsWith('org:') ? value.slice('org:'.length) : value).trim();
  if (alias.length === 0 || /[\u0000-\u001f]/u.test(alias)) {
    throw new SfudError('INVALID_ARGUMENT', '대상 org 별칭이 비어 있습니다.');
  }
  return alias;
}

function emitJsonIfRequested(
  json: boolean | undefined,
  stdout: (value: string) => void,
  result: DeployCommandResult,
): void {
  if (json) {
    stdout(`${JSON.stringify(result, null, 2)}\n`);
  }
}
