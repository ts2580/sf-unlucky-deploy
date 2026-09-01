import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import type { MetadataTypeDescriptor } from '../metadata/component-resolver.js';
import {
  ensureEmptyDirectory,
  findPackageRoot,
  pathExists,
  sha256Directory,
  sha256File,
  writeJson,
} from '../core/files.js';
import type { SfClient } from '../salesforce/sf-client.js';
import type { SourceSpec } from './source-spec.js';

export interface SnapshotOptions {
  source: SourceSpec;
  manifestPath: string;
  retrievalManifestPath?: string;
  outputDir: string;
  commandProjectPath: string;
  sfClient: SfClient;
  waitMinutes?: number;
  commandTimeoutMs?: number;
  metadataTypes?: MetadataTypeDescriptor[];
  empty?: boolean;
}

export interface MetadataSnapshot {
  source: SourceSpec;
  packageRoot: string;
  manifestPath: string;
  manifestSha256: string;
  payloadSha256: string;
  createdAt: string;
  metadataTypes?: MetadataTypeDescriptor[];
}

export async function createSnapshot(options: SnapshotOptions): Promise<MetadataSnapshot> {
  const manifestPath = path.resolve(options.manifestPath);
  const retrievalManifestPath = path.resolve(options.retrievalManifestPath ?? options.manifestPath);
  await validateInputs(options.source, manifestPath);
  if (retrievalManifestPath !== manifestPath && !(await pathExists(retrievalManifestPath))) {
    throw new SfudError('INVALID_ARGUMENT', `retrieve manifest 파일을 찾을 수 없습니다: ${retrievalManifestPath}`);
  }
  await ensureEmptyDirectory(options.outputDir);

  const rawDir = path.join(options.outputDir, 'raw');
  await mkdir(rawDir, { recursive: true });

  let packageRoot: string;
  if (options.empty === true) {
    packageRoot = path.join(rawDir, 'sfud');
    await mkdir(packageRoot, { recursive: true });
    await copyFile(manifestPath, path.join(packageRoot, 'package.xml'));
  } else if (options.source.kind === 'org') {
    await options.sfClient.runJson(
      [
        'project',
        'retrieve',
        'start',
        '--target-org',
        options.source.alias,
        '--manifest',
        retrievalManifestPath,
        '--target-metadata-dir',
        rawDir,
        '--unzip',
        '--single-package',
        '--wait',
        String(options.waitMinutes ?? 60),
      ],
      {
        cwd: options.commandProjectPath,
        ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
      },
    );
    packageRoot = await findPackageRoot(rawDir);
  } else {
    await options.sfClient.runJson(
      [
        'project',
        'convert',
        'source',
        '--manifest',
        retrievalManifestPath,
        '--output-dir',
        rawDir,
        '--package-name',
        'sfud',
      ],
      {
        cwd: options.source.projectPath,
        ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
      },
    );
    packageRoot = await findPackageRoot(rawDir);
  }

  const snapshot: MetadataSnapshot = {
    source: options.source,
    packageRoot,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    payloadSha256: await sha256Directory(packageRoot),
    createdAt: new Date().toISOString(),
    ...(options.metadataTypes === undefined ? {} : { metadataTypes: options.metadataTypes }),
  };

  await writeJson(path.join(options.outputDir, 'snapshot.json'), snapshot);
  return snapshot;
}

async function validateInputs(source: SourceSpec, manifestPath: string): Promise<void> {
  if (!(await pathExists(manifestPath))) {
    throw new SfudError('INVALID_ARGUMENT', `manifest 파일을 찾을 수 없습니다: ${manifestPath}`);
  }

  if (source.kind === 'local') {
    if (!(await pathExists(source.projectPath))) {
      throw new SfudError('INVALID_SOURCE', `로컬 프로젝트를 찾을 수 없습니다: ${source.projectPath}`);
    }
    if (!(await pathExists(path.join(source.projectPath, 'sfdx-project.json')))) {
      throw new SfudError(
        'INVALID_SOURCE',
        `sfdx-project.json이 없는 로컬 경로입니다: ${source.projectPath}`,
      );
    }
  }
}
