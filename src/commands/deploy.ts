import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { sha256Directory, writeJson } from '../core/files.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import {
  selectApexTestPlan,
  type ApexTestPlan,
  type RequestedTestLevel,
} from '../deploy/test-plan.js';
import { requireMinimumApexCoverage } from '../deploy/test-coverage.js';
import { compareSnapshots, type ComparisonResult } from '../metadata/comparator.js';
import { generateDeployableManifest } from '../metadata/deployable-manifest.js';
import { renderTerminalReport } from '../reports/terminal.js';
import { writeComparisonReports, type ReportPaths } from '../reports/writer.js';
import {
  ProcessSfClient,
  sanitizeSfOutput,
  type SfClient,
} from '../salesforce/sf-client.js';
import {
  runAsyncSalesforceDeployment,
  type SalesforceDeploymentProgress,
} from '../deploy/salesforce-deployment.js';
import { parseSourceSpec } from '../sources/source-spec.js';
import { createSnapshot } from '../sources/snapshot.js';
import { createRunContext, writeRunMetadata } from './run-context.js';

export interface DeployCommandOptions {
  from: string;
  to: string;
  manifest?: string;
  allMetadata?: boolean;
  metadataType?: string;
  reportDir?: string;
  dryRun?: boolean;
  execute?: boolean;
  skipDryRun?: boolean;
  minimumCoverage?: number;
  testLevel?: RequestedTestLevel;
  tests?: string[];
  testClassSuffix?: string;
  wait?: number;
  strict?: boolean;
  json?: boolean;
  color?: boolean;
}

export interface DeployCommandDependencies {
  cwd?: string;
  sfClient?: SfClient;
  stdout?: (value: string) => void;
  requestWorkspacePath?: string;
  onDeploymentSubmitted?: (deploymentId: string, phase: 'DRY_RUN' | 'DEPLOY') => Promise<void> | void;
  onDeploymentProgress?: (progress: SalesforceDeploymentProgress) => Promise<void> | void;
  onDeploymentPersistenceError?: (
    stage: 'submission' | 'progress',
    error: unknown,
    phase: 'DRY_RUN' | 'DEPLOY',
  ) => Promise<void> | void;
}

export interface DeployCommandResult {
  comparison: ComparisonResult;
  payloadSha256: string;
  reports: ReportPaths;
  runDirectory: string;
  dryRunResult?: unknown;
  deployResult?: unknown;
  executed: boolean;
  testPlan: ApexTestPlan;
  persistenceWarnings?: string[];
}

export async function runDeployCommand(
  options: DeployCommandOptions,
  dependencies: DeployCommandDependencies = {},
): Promise<DeployCommandResult> {
  validateDeployOptions(options);
  const cwd = dependencies.cwd ?? process.cwd();
  const sfClient = dependencies.sfClient ?? new ProcessSfClient();
  if (dependencies.requestWorkspacePath === undefined) {
    return await withRequestWorkspace(cwd, async (requestWorkspacePath) =>
      runDeployCommand(options, { ...dependencies, cwd, sfClient, requestWorkspacePath }));
  }
  const commandProjectPath = dependencies.requestWorkspacePath;
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const source = parseSourceSpec(options.from, cwd);
  const targetAlias = normalizeTargetAlias(options.to);
  const targetSource = parseSourceSpec(`org:${targetAlias}`, cwd);
  const context = await createRunContext(cwd, options.reportDir, 'deploy');
  const generatedManifest = options.allMetadata === true || options.metadataType !== undefined
    ? await generateDeployableManifest({
      sources: [targetSource, source],
      ...(options.metadataType === undefined ? {} : { metadataTypes: [options.metadataType] }),
      outputDirectory: path.join(context.rootDirectory, 'generated-manifest'),
      commandProjectPath,
      sfClient,
    })
    : undefined;
  const manifestPath = generatedManifest?.manifestPath
    ?? path.resolve(cwd, options.manifest ?? 'manifest/package.xml');
  const sourceManifests = generatedManifest?.sourceManifests;
  await writeRunMetadata(context, 'deploy', targetSource, source.displayName, manifestPath);

  const [targetSnapshot, sourceSnapshot] = await Promise.all([
    createSnapshot({
      source: targetSource,
      manifestPath,
      ...(sourceManifests === undefined ? {} : {
        retrievalManifestPath: sourceManifests[0]!.manifestPath,
      }),
      outputDir: context.leftSnapshotDirectory,
      commandProjectPath,
      sfClient,
      waitMinutes: options.wait ?? 60,
      ...(sourceManifests?.[0]?.empty === true ? { empty: true } : {}),
      ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
    }),
    createSnapshot({
      source,
      manifestPath,
      ...(sourceManifests === undefined ? {} : {
        retrievalManifestPath: sourceManifests[1]!.manifestPath,
      }),
      outputDir: context.rightSnapshotDirectory,
      commandProjectPath,
      sfClient,
      waitMinutes: options.wait ?? 60,
      ...(sourceManifests?.[1]?.empty === true ? { empty: true } : {}),
      ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
    }),
  ]);

  const comparison = await compareSnapshots(targetSnapshot, sourceSnapshot, {
    strict: options.strict ?? false,
  });
  if (comparison.summary.removed > 0) {
    comparison.warnings.push(
      'TARGET ONLY는 target에만 존재하는 차이이며 destructive manifest 없이는 실제로 삭제되지 않습니다.',
    );
  }
  const deploymentSnapshot = generatedManifest === undefined
    ? sourceSnapshot
    : await createSnapshot({
      source,
      manifestPath: generatedManifest.sourceManifests[1]!.manifestPath,
      outputDir: path.join(context.rootDirectory, 'deploy-payload'),
      commandProjectPath,
      sfClient,
      waitMinutes: options.wait ?? 60,
      metadataTypes: generatedManifest.metadataTypes,
      ...(generatedManifest.sourceManifests[1]!.empty ? { empty: true } : {}),
    });
  const testPlan = await selectApexTestPlan(
    deploymentSnapshot.packageRoot,
    options.testLevel ?? 'auto',
    options.tests ?? [],
    options.testClassSuffix ?? '_Test',
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

  await assertPayloadUnchanged(deploymentSnapshot.packageRoot, deploymentSnapshot.payloadSha256);
  const deployArgs = buildDeployArgs(options, deploymentSnapshot.packageRoot, targetAlias, testPlan);
  const payloadEmpty = generatedManifest?.sourceManifests[1]?.empty === true;
  const persistenceWarnings: string[] = [];
  const dryRunResult = options.skipDryRun === true
    ? undefined
    : payloadEmpty
      ? emptyDeploymentResult(true)
      : sanitizeSfOutput(await runDeploymentRequest(
        sfClient,
        [...deployArgs, '--dry-run'],
        targetAlias,
        commandProjectPath,
        options.wait,
        'DRY_RUN',
        dependencies.onDeploymentSubmitted,
        dependencies.onDeploymentProgress,
        dependencies.onDeploymentPersistenceError,
      ));
  if (dryRunResult !== undefined) {
    try {
      await writeJson(path.join(context.logsDirectory, 'dry-run.json'), dryRunResult);
    } catch (error) {
      persistenceWarnings.push(artifactWarning('dry-run', error));
    }
  }
  if (options.minimumCoverage !== undefined) {
    requireMinimumApexCoverage(dryRunResult, options.minimumCoverage);
  }

  let deployResult: unknown;
  if (options.execute) {
    await assertPayloadUnchanged(deploymentSnapshot.packageRoot, deploymentSnapshot.payloadSha256);
    deployResult = payloadEmpty
      ? emptyDeploymentResult(false)
      : sanitizeSfOutput(await runDeploymentRequest(
        sfClient,
        deployArgs,
        targetAlias,
        commandProjectPath,
        options.wait,
        'DEPLOY',
        dependencies.onDeploymentSubmitted,
        dependencies.onDeploymentProgress,
        dependencies.onDeploymentPersistenceError,
      ));
    try {
      await writeJson(path.join(context.logsDirectory, 'deploy.json'), deployResult);
    } catch (error) {
      persistenceWarnings.push(artifactWarning('deploy', error));
    }
  }

  const result: DeployCommandResult = {
    comparison,
    payloadSha256: deploymentSnapshot.payloadSha256,
    reports,
    runDirectory: context.rootDirectory,
    ...(dryRunResult === undefined ? {} : { dryRunResult }),
    ...(deployResult === undefined ? {} : { deployResult }),
    executed: options.execute ?? false,
    testPlan,
    ...(persistenceWarnings.length === 0 ? {} : { persistenceWarnings }),
  };
  if (!options.json) {
    stdout(options.execute
      ? options.skipDryRun === true ? '실제 배포 완료\n' : 'dry-run 및 실제 배포 완료\n'
      : 'dry-run 완료 (실제 배포는 실행하지 않음)\n');
  }
  emitJsonIfRequested(options.json, stdout, result);
  return result;
}

function artifactWarning(phase: 'dry-run' | 'deploy', error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${phase} Salesforce 결과 파일 저장 실패: ${message}`;
}

function emptyDeploymentResult(checkOnly: boolean): unknown {
  return {
    status: 0,
    result: {
      status: 'Succeeded',
      checkOnly,
      empty: true,
      message: '배포할 source 메타데이터가 없어 Salesforce 요청을 생략했습니다.',
    },
  };
}

async function runDeploymentRequest(
  sfClient: SfClient,
  args: readonly string[],
  targetAlias: string,
  cwd: string,
  waitMinutes = 60,
  phase: 'DRY_RUN' | 'DEPLOY',
  onSubmitted?: (deploymentId: string, phase: 'DRY_RUN' | 'DEPLOY') => Promise<void> | void,
  onProgress?: (progress: SalesforceDeploymentProgress) => Promise<void> | void,
  onPersistenceError?: (
    stage: 'submission' | 'progress',
    error: unknown,
    phase: 'DRY_RUN' | 'DEPLOY',
  ) => Promise<void> | void,
): Promise<unknown> {
  return await runAsyncSalesforceDeployment({
    sfClient,
    startArgs: args,
    targetAlias,
    cwd,
    waitMinutes,
    phase,
    ...(onSubmitted === undefined ? {} : {
      onSubmitted: async (deploymentId: string) => { await onSubmitted(deploymentId, phase); },
    }),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(onPersistenceError === undefined ? {} : {
      onPersistenceError: async (stage: 'submission' | 'progress', error: unknown) => {
        await onPersistenceError(stage, error, phase);
      },
    }),
  });
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
  if (options.skipDryRun === true && options.execute !== true) {
    throw new SfudError('INVALID_ARGUMENT', 'dry-run 생략은 실제 배포 실행에서만 사용할 수 있습니다.');
  }
  if (options.minimumCoverage !== undefined
    && (!Number.isFinite(options.minimumCoverage) || options.minimumCoverage < 0 || options.minimumCoverage > 100)) {
    throw new SfudError('INVALID_ARGUMENT', '최소 Apex 테스트 커버리지는 0부터 100 사이여야 합니다.');
  }
  if (options.skipDryRun === true && options.minimumCoverage !== undefined) {
    throw new SfudError('INVALID_ARGUMENT', '커버리지 검증과 dry-run 생략을 함께 사용할 수 없습니다.');
  }
  if (options.wait !== undefined && (!Number.isInteger(options.wait) || options.wait < 1)) {
    throw new SfudError('INVALID_ARGUMENT', '--wait는 1 이상의 정수여야 합니다.');
  }
  if (options.allMetadata !== true && options.metadataType === undefined && options.manifest === undefined) {
    throw new SfudError('INVALID_ARGUMENT', 'manifest 또는 전체 metadata 범위가 필요합니다.');
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
