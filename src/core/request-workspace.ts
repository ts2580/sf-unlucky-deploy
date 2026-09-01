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
  await chmod(workspacePath, 0o700);
  try {
    await initializeWorkspace(workspacePath, await readProjectApiVersion(templateProjectPath));
    return await task(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
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
