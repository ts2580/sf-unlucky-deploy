import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withRequestWorkspace } from '../src/core/request-workspace.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rm: vi.fn(original.rm) };
});

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(rm).mockReset().mockImplementation(realFs.rm);
  await Promise.all(directories.splice(0).map((directory) =>
    realFs.rm(directory, { recursive: true, force: true })));
});

describe('임시 workspace 정리 실패 격리', () => {
  it('정리 재시도가 소진되어도 성공 결과를 보존하고 남은 경로를 경고한다', async () => {
    const template = await mkdtemp(path.join(os.tmpdir(), 'sfud-cleanup-test-'));
    directories.push(template);
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    const result = { compared: true };
    let workspace = '';

    await expect(withRequestWorkspace(template, async (directory) => {
      workspace = directory;
      directories.push(directory);
      return result;
    })).resolves.toBe(result);

    expect(rm).toHaveBeenCalledWith(workspace,
      { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(workspace),
      { code: 'SFUD_WORKSPACE_CLEANUP_FAILED' });
  });

  it('정리 오류가 원래 작업 오류를 덮지 않는다', async () => {
    const template = await mkdtemp(path.join(os.tmpdir(), 'sfud-cleanup-test-'));
    directories.push(template);
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    const originalError = new Error('Salesforce request failed');

    await expect(withRequestWorkspace(template, async (directory) => {
      directories.push(directory);
      throw originalError;
    })).rejects.toBe(originalError);
  });
});
