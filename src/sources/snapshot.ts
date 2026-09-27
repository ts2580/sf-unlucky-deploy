import type { WorkspaceSource } from '../api/workspace-contracts.js';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import type { MetadataTypeDescriptor } from '../metadata/component-resolver.js';
import {
  ensureEmptyDirectory,
  findPackageRoot,
  pathExists,
  sha256DirectoryV2,
  sha256File,
  writeJson,
} from '../core/files.js';
import type { SfClient } from '../salesforce/sf-client.js';
import type { SourceSpec } from './source-spec.js';

export interface SnapshotOptions {
  provenance?: NonNullable<WorkspaceSource['provenance']>;
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
  signal?: AbortSignal;
}

export interface MetadataSnapshot {
  provenance?: NonNullable<WorkspaceSource['provenance']>;
  source: SourceSpec;
  packageRoot: string;
  manifestPath: string;
  manifestSha256: string;
  payloadSha256: string;
  payloadDigestVersion?: 2;
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
  await mkdir(rawDir, { recursive: true, mode: 0o700 });

  let packageRoot: string;
  if (options.empty === true) {
    packageRoot = path.join(rawDir, 'sfud');
    await mkdir(packageRoot, { recursive: true, mode: 0o700 });
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    packageRoot = await findPackageRoot(rawDir);
  } else {
    // The run directory may live under a Salesforce project whose .forceignore
    // excludes .sfud/**.  SDR applies the discovered project's ignore rules to
    // convert output, so writing directly to rawDir can silently leave only
    // package.xml while reporting success.  Convert outside every project and
    // copy the resulting package into the run artifact afterwards.
    const conversionDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-convert-'));
    try {
      await options.sfClient.runJson(
        [
          'project',
          'convert',
          'source',
          '--manifest',
          retrievalManifestPath,
          '--output-dir',
          conversionDirectory,
          '--package-name',
          'sfud',
        ],
        {
          cwd: options.source.projectPath,
          ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      await copyDirectoryContents(conversionDirectory, rawDir);
    } finally {
      await rm(conversionDirectory, { recursive: true, force: true });
    }
    packageRoot = await findPackageRoot(rawDir);
  }

  const snapshot: MetadataSnapshot = {
    source: options.source,
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
    packageRoot,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    payloadSha256: await sha256DirectoryV2(packageRoot),
    payloadDigestVersion: 2,
    createdAt: new Date().toISOString(),
    ...(options.metadataTypes === undefined ? {} : { metadataTypes: options.metadataTypes }),
  };

  await writeJson(path.join(options.outputDir, 'snapshot.json'), snapshot);
  return snapshot;
}

async function copyDirectoryContents(sourceDirectory: string, targetDirectory: string): Promise<void> {
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: 0o700 });
      await copyDirectoryContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    } else {
      throw new SfudError('SNAPSHOT_FAILED', `변환 결과에 지원하지 않는 파일 형식이 있습니다: ${entry.name}`);
    }
  }
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
