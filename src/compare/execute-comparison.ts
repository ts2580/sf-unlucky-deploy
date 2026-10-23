import type { JobSourceSnapshot } from '../sources/public.js';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { compareSnapshots, type ComparisonResult } from '../metadata/public.js';
import { generateDeployableManifest } from '../metadata/public.js';
import { withRequestWorkspace } from '../core/request-workspace.js';
import { writeComparisonReports, type ReportPaths } from '../reports/public.js';
import { ProcessSfClient, type SfClient } from '../salesforce/public.js';
import { parseSourceSpec } from '../sources/public.js';
import { createSnapshot } from '../sources/public.js';
import { createRunContext, writeRunMetadata } from '../sources/public.js';
import { settledSnapshots } from '../sources/public.js';
import { salesforceWaitCommandTimeoutMs } from '../core/deadline.js';
import { resolvePackageExclusion, validateExcludedPackageIds } from '../metadata/public.js';
import type { PackageComponentResolver } from '../metadata/public.js';

export interface ExecuteComparisonOptions {
  excludedPackageIds?: string[];
  excludePackageMetadata?: boolean;
  left: string;
  right: string;
  sourceOnly?: boolean;
  maximumComparisonFiles?: number;
  manifest?: string;
  allMetadata?: boolean;
  metadataType?: string;
  componentKeys?: readonly string[];
  wait?: number;
  reportDir?: string;
  showIdentical?: boolean;
  strict?: boolean;
}

export interface ExecuteComparisonDependencies {
  packageComponentResolver?: PackageComponentResolver;
  sourceSnapshot?: JobSourceSnapshot;
  cwd?: string;
  sfClient?: SfClient;
  signal?: AbortSignal;
}

export interface ExecuteComparisonResult {
  comparison: ComparisonResult;
  reports: ReportPaths;
  runDirectory: string;
}

export async function executeComparison(
  options: ExecuteComparisonOptions,
  dependencies: ExecuteComparisonDependencies = {},
): Promise<ExecuteComparisonResult> {
  const cwd = dependencies.cwd ?? process.cwd();
  const sfClient = dependencies.sfClient ?? new ProcessSfClient();
  const leftSource = parseSourceSpec(options.left, cwd);
  const rightSource = parseSourceSpec(options.right, cwd);
  const excludedPackageIds = validateExcludedPackageIds(options.excludedPackageIds);
  if (options.excludePackageMetadata === true && excludedPackageIds.length > 0) {
    throw new SfudError('INVALID_ARGUMENT', '패키지 전체 제외와 개별 제외는 함께 선택할 수 없습니다.');
  }
  return await withRequestWorkspace(cwd, async (commandProjectPath) => {
    const packageExclusion = options.excludePackageMetadata === true || excludedPackageIds.length > 0
      ? await resolvePackageExclusion(options.sourceOnly === true ? [rightSource] : [leftSource, rightSource],
        sfClient, commandProjectPath, dependencies.signal, excludedPackageIds.length > 0 ? excludedPackageIds : undefined,
        dependencies.packageComponentResolver)
      : undefined;
    const context = await createRunContext(cwd, options.reportDir, 'compare');
    const generatedManifest = options.allMetadata === true || options.metadataType !== undefined
      ? await generateDeployableManifest({
        sources: options.sourceOnly === true ? [rightSource] : [leftSource, rightSource],
        ...(options.metadataType === undefined ? {} : { metadataTypes: [options.metadataType] }),
        outputDirectory: path.join(context.rootDirectory, 'generated-manifest'),
        commandProjectPath,
        sfClient,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      })
      : undefined;
    const manifestPath = generatedManifest?.manifestPath
      ?? path.resolve(cwd, options.manifest ?? 'manifest/package.xml');
    const sourceManifests = generatedManifest?.sourceManifests;
    const snapshotWaitMinutes = options.wait ?? 60;
    if (!Number.isInteger(snapshotWaitMinutes) || snapshotWaitMinutes < 1) {
      throw new SfudError('INVALID_ARGUMENT', '--wait는 1 이상의 정수여야 합니다.');
    }
    const snapshotCommandTimeoutMs = salesforceWaitCommandTimeoutMs(snapshotWaitMinutes);
    await writeRunMetadata(context, 'compare', leftSource, rightSource.displayName, manifestPath, dependencies.sourceSnapshot);

    const [leftSnapshot, rightSnapshot] = await settledSnapshots([
      createSnapshot({
        source: options.sourceOnly === true ? rightSource : leftSource,
        ...(dependencies.sourceSnapshot?.left?.provenance === undefined ? {} : { provenance: dependencies.sourceSnapshot.left.provenance }),
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
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        ...(options.sourceOnly === true || sourceManifests?.[0]?.empty === true ? { empty: true } : {}),
        ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
      }),
      createSnapshot({
        source: rightSource,
        ...(dependencies.sourceSnapshot?.right?.provenance === undefined ? {} : { provenance: dependencies.sourceSnapshot.right.provenance }),
        manifestPath,
        ...(sourceManifests === undefined ? {} : {
          retrievalManifestPath: sourceManifests[options.sourceOnly === true ? 0 : 1]!.manifestPath,
        }),
        outputDir: context.rightSnapshotDirectory,
        commandProjectPath,
        sfClient,
        waitMinutes: snapshotWaitMinutes,
        commandTimeoutMs: snapshotCommandTimeoutMs,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        ...(sourceManifests?.[options.sourceOnly === true ? 0 : 1]?.empty === true ? { empty: true } : {}),
        ...(generatedManifest === undefined ? {} : { metadataTypes: generatedManifest.metadataTypes }),
      }),
    ]);

    const comparison = await compareSnapshots(leftSnapshot, rightSnapshot, { strict: options.strict ?? false,
      ...(options.componentKeys === undefined ? {} : { componentKeys: options.componentKeys }),
      ...(packageExclusion === undefined ? {} : { packageExclusion }),
      ...(options.maximumComparisonFiles === undefined || options.sourceOnly === true
        ? {} : { maximumFiles: options.maximumComparisonFiles }),
      ...(options.metadataType === undefined ? {} : { metadataType: options.metadataType }) });
    const reports = await writeComparisonReports(comparison, context.reportDirectory);
    return {
      comparison,
      reports,
      runDirectory: context.rootDirectory,
    };
  });
}
