import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('TS/TSX React async lint', () => {
  it('effect에 직접 전달한 async callback을 실패시키고 void 내부 호출은 허용한다', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sfud-ts-react-lint-'));
    directories.push(directory);
    const invalid = path.join(directory, 'invalid.tsx');
    const valid = path.join(directory, 'valid.tsx');
    await writeFile(invalid, "useEffect(async () => { await refresh(); }, []);\n");
    await writeFile(valid, "useEffect(() => { void refresh(); }, []);\nuseCallback(async () => await refresh(), []);\n");

    await expect(execute(process.execPath, ['scripts/lint-ts-react.mjs', invalid], { cwd: process.cwd() }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('React hook에는 async 함수를 직접 전달') });
    await expect(execute(process.execPath, ['scripts/lint-ts-react.mjs', valid], { cwd: process.cwd() }))
      .resolves.toMatchObject({ stdout: expect.stringContaining('PASS') });
  });
});
