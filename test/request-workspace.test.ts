import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { withRequestWorkspace } from '../src/core/request-workspace.js';

const temporaryDirectories: string[] = [];

describe('요청별 임시 DX workspace', () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it('매 요청마다 새 디렉터리를 초기화하고 완료 후 제거한다', async () => {
    const template = await createTemplate();
    const observed: string[] = [];

    for (let index = 0; index < 2; index += 1) {
      await withRequestWorkspace(template, async (workspacePath) => {
        observed.push(workspacePath);
        if (process.platform !== 'win32') expect((await stat(workspacePath)).mode & 0o777).toBe(0o700);
        expect(JSON.parse(await readFile(path.join(workspacePath, 'sfdx-project.json'), 'utf8')))
          .toMatchObject({
            name: 'sfud-request-workspace',
            sourceApiVersion: '66.0',
            packageDirectories: [{ path: 'force-app', default: true }],
          });
        await expect(access(path.join(workspacePath, 'force-app'))).resolves.toBeUndefined();
      });
    }

    expect(observed[0]).not.toBe(observed[1]);
    await Promise.all(observed.map(async (workspacePath) =>
      expect(access(workspacePath)).rejects.toThrow()));
  });

  it('요청이 실패해도 임시 디렉터리를 제거한다', async () => {
    const template = await createTemplate();
    let observed = '';

    await expect(withRequestWorkspace(template, async (workspacePath) => {
      observed = workspacePath;
      throw new Error('request failed');
    })).rejects.toThrow('request failed');

    await expect(access(observed)).rejects.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('Windows 자식 프로세스의 cwd 잠금이 풀리면 재시도로 정리한다', async () => {
    const template = await createTemplate();
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let observed = '';
    try {
      await expect(withRequestWorkspace(template, async (workspacePath) => {
        observed = workspacePath;
        temporaryDirectories.push(workspacePath);
        child = spawn(process.execPath, ['-e',
          "process.on('message', () => setTimeout(() => process.exit(0), 500)); process.send('ready');"],
        { cwd: workspacePath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
        closed = once(child, 'close');
        await once(child, 'message');
        await expect(rm(workspacePath, { recursive: true, force: true }))
          .rejects.toMatchObject({ code: 'EBUSY' });
        child.send('release');
        return 'completed';
      })).resolves.toBe('completed');
      await expect(access(observed)).rejects.toThrow();
    } finally {
      child?.kill();
      await closed;
    }
  });
});

async function createTemplate(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-workspace-template-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'force-app'));
  await writeFile(path.join(root, 'sfdx-project.json'), JSON.stringify({ sourceApiVersion: '66.0' }));
  return root;
}
