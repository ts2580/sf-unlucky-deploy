import path from 'node:path';

import { ensureEmptyDirectory, writeJson } from '../core/files.js';
import { assertRunStorageCapacity } from '../storage/run-storage.js';
import type { SourceSpec } from '../sources/source-spec.js';

export interface RunContext {
  runId: string;
  rootDirectory: string;
  reportDirectory: string;
  leftSnapshotDirectory: string;
  rightSnapshotDirectory: string;
  logsDirectory: string;
}

export async function createRunContext(
  cwd: string,
  explicitDirectory: string | undefined,
  command: 'compare' | 'deploy',
): Promise<RunContext> {
  const runId = createRunId(command);
  const rootDirectory = explicitDirectory
    ? path.resolve(cwd, explicitDirectory)
    : path.join(cwd, '.sfud', 'runs', runId);

  await ensureEmptyDirectory(rootDirectory);
  await assertRunStorageCapacity(rootDirectory);
  return {
    runId,
    rootDirectory,
    reportDirectory: path.join(rootDirectory, 'reports'),
    leftSnapshotDirectory: path.join(rootDirectory, 'left'),
    rightSnapshotDirectory: path.join(rootDirectory, 'right'),
    logsDirectory: path.join(rootDirectory, 'logs'),
  };
}

export async function writeRunMetadata(
  context: RunContext,
  command: 'compare' | 'deploy',
  left: SourceSpec,
  rightDisplayName: string,
  manifestPath: string,
): Promise<void> {
  await writeJson(path.join(context.rootDirectory, 'run.json'), {
    runId: context.runId,
    command,
    createdAt: new Date().toISOString(),
    left: left.displayName,
    right: rightDisplayName,
    manifestPath,
  });
}

function createRunId(command: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  return `${timestamp}-${command}-${process.pid}`;
}
