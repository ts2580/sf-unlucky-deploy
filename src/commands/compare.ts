import path from 'node:path';

import { compareSnapshots, type ComparisonResult } from '../metadata/comparator.js';
import { writeComparisonReports, type ReportPaths } from '../reports/writer.js';
import { renderTerminalReport } from '../reports/terminal.js';
import { ProcessSfClient, type SfClient } from '../salesforce/sf-client.js';
import { parseSourceSpec } from '../sources/source-spec.js';
import { createSnapshot } from '../sources/snapshot.js';
import { createRunContext, writeRunMetadata } from './run-context.js';

export interface CompareCommandOptions {
  left: string;
  right: string;
  manifest: string;
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
  const manifestPath = path.resolve(cwd, options.manifest);
  const leftSource = parseSourceSpec(options.left, cwd);
  const rightSource = parseSourceSpec(options.right, cwd);
  const context = await createRunContext(cwd, options.reportDir, 'compare');
  await writeRunMetadata(context, 'compare', leftSource, rightSource.displayName, manifestPath);

  const [leftSnapshot, rightSnapshot] = await Promise.all([
    createSnapshot({
      source: leftSource,
      manifestPath,
      outputDir: context.leftSnapshotDirectory,
      commandProjectPath: cwd,
      sfClient,
    }),
    createSnapshot({
      source: rightSource,
      manifestPath,
      outputDir: context.rightSnapshotDirectory,
      commandProjectPath: cwd,
      sfClient,
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
}
