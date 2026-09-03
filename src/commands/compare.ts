import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { compareSnapshots, type ComparisonResult } from '../metadata/comparator.js';
import { generateDeployableManifest } from '../metadata/deployable-manifest.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import { writeComparisonReports, type ReportPaths } from '../reports/writer.js';
import { renderTerminalReport } from '../reports/terminal.js';
import { ProcessSfClient, type SfClient } from '../salesforce/sf-client.js';
import { parseSourceSpec } from '../sources/source-spec.js';
import { createSnapshot } from '../sources/snapshot.js';
import { createRunContext, writeRunMetadata } from './run-context.js';

export interface CompareCommandOptions {
  left: string;
  right: string;
  sourceOnly?: boolean;
  manifest?: string;
  allMetadata?: boolean;
  metadataType?: string;
  wait?: number;
  reportDir?: string;
  detail?: boolean;
  showIdentical?: boolean;
  strict?: boolean;
  failOnDiff?: boolean;
  json?: boolean;
  color?: boolean;
}

export interface CommandDependencies {
  cwd?: string;
  sfClient?: SfClient;
  stdout?: (value: string) => void;
}

export interface CompareCommandResult {
  comparison: ComparisonResult;
  reports: ReportPaths;
  runDirectory: string;
  exitCode: number;
}

export async function runCompareCommand(
  options: CompareCommandOptions,
  dependencies: CommandDependencies = {},
): Promise<CompareCommandResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const sfClient = dependencies.sfClient ?? new ProcessSfClient();
  const leftSource = parseSourceSpec(options.left, cwd);
  const rightSource = parseSourceSpec(options.right, cwd);
  return await withRequestWorkspace(cwd, async (commandProjectPath) => {
    const context = await createRunContext(cwd, options.reportDir, 'compare');
    const generatedManifest = options.allMetadata === true || options.metadataType !== undefined
      ? await generateDeployableManifest({
        sources: options.sourceOnly === true ? [rightSource] : [leftSource, rightSource],
        ...(options.metadataType === undefined ? {} : { metadataTypes: [options.metadataType] }),
        outputDirectory: path.join(context.rootDirectory, 'generated-manifest'),
        commandProjectPath,
        sfClient,
      })
      : undefined;
    const manifestPath = generatedManifest?.manifestPath
      ?? path.resolve(cwd, options.manifest ?? 'manifest/package.xml');
    const sourceManifests = generatedManifest?.sourceManifests;
    const snapshotWaitMinutes = options.wait ?? 60;
    if (!Number.isInteger(snapshotWaitMinutes) || snapshotWaitMinutes < 1) {
      throw new SfudError('INVALID_ARGUMENT', '--wait는 1 이상의 정수여야 합니다.');
    }
    const snapshotCommandTimeoutMs = (snapshotWaitMinutes + 1) * 60 * 1000;
    await writeRunMetadata(context, 'compare', leftSource, rightSource.displayName, manifestPath);

    const [leftSnapshot, rightSnapshot] = await Promise.all([
      createSnapshot({
        source: options.sourceOnly === true ? rightSource : leftSource,
        manifestPath,
        ...(options.sourceOnly === true
          ? {}
          : sourceManifests === undefined ? {} : {
          retrievalManifestPath: sourceManifests[0]!.manifestPath,
        }),
        outputDir: context.leftSnapshotDirectory,
        commandProjectPath,
        sfClient,
        waitMinutes: snapshotWaitMinutes,
        commandTimeoutMs: snapshotCommandTimeoutMs,
        ...(options.sourceOnly === true || sourceManifests?.[0]?.empty === true ? { empty: true } : {}),
        ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
      }),
      createSnapshot({
        source: rightSource,
        manifestPath,
        ...(sourceManifests === undefined ? {} : {
          retrievalManifestPath: sourceManifests[options.sourceOnly === true ? 0 : 1]!.manifestPath,
        }),
        outputDir: context.rightSnapshotDirectory,
        commandProjectPath,
        sfClient,
        waitMinutes: snapshotWaitMinutes,
        commandTimeoutMs: snapshotCommandTimeoutMs,
        ...(sourceManifests?.[options.sourceOnly === true ? 0 : 1]?.empty === true ? { empty: true } : {}),
        ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
      }),
    ]);

    const comparison = await compareSnapshots(leftSnapshot, rightSnapshot, { strict: options.strict ?? false });
    const reports = await writeComparisonReports(comparison, context.reportDirectory);
    const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));

    if (options.json) {
      stdout(`${JSON.stringify({ comparison, reports }, null, 2)}\n`);
    } else {
      stdout(
        renderTerminalReport(comparison, {
          detail: options.detail ?? false,
          onlyChanged: !options.showIdentical,
          color: options.color ?? process.stdout.isTTY,
        }),
      );
      stdout(`리포트: ${reports.html}\n`);
    }

    return {
      comparison,
      reports,
      runDirectory: context.rootDirectory,
      exitCode: options.failOnDiff && comparison.summary.different > 0 ? 1 : 0,
    };
  });
}
