import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_API_VERSION = '67.0';

interface ProjectConfiguration {
  sourceApiVersion?: unknown;
}

export async function withRequestWorkspace<T>(
  templateProjectPath: string,
  task: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sfud-request-'));
  try {
    await chmod(workspacePath, 0o700);
    await initializeWorkspace(workspacePath, await readProjectApiVersion(templateProjectPath));
    return await task(workspacePath);
  } finally {
    try {
      await rm(workspacePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Cleanup must not replace a completed comparison/deployment or its original error.
      process.emitWarning(`임시 작업 폴더를 정리하지 못했습니다. 작업 종료 후 삭제해 주세요: ${workspacePath}`, {
        code: 'SFUD_WORKSPACE_CLEANUP_FAILED',
      });
    }
  }
}

async function initializeWorkspace(workspacePath: string, sourceApiVersion: string): Promise<void> {
  await mkdir(path.join(workspacePath, 'force-app'), { recursive: true });
  await writeFile(path.join(workspacePath, 'sfdx-project.json'), `${JSON.stringify({
    packageDirectories: [{ path: 'force-app', default: true }],
    name: 'sfud-request-workspace',
    namespace: '',
    sfdcLoginUrl: 'https://login.salesforce.com',
    sourceApiVersion,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function readProjectApiVersion(templateProjectPath: string): Promise<string> {
  try {
    const configuration = JSON.parse(
      await readFile(path.join(templateProjectPath, 'sfdx-project.json'), 'utf8'),
    ) as ProjectConfiguration;
    return typeof configuration.sourceApiVersion === 'string'
      && /^\d+\.\d+$/u.test(configuration.sourceApiVersion)
      ? configuration.sourceApiVersion
      : DEFAULT_API_VERSION;
  } catch {
    return DEFAULT_API_VERSION;
  }
}
