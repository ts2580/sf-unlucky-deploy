import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLI_VERSION, createProgram } from '../src/program.js';

describe('sfud CLI', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('이름과 설명을 제공한다', () => {
    const program = createProgram();

    expect(program.name()).toBe('sfud');
    expect(program.description()).toContain('Salesforce 메타데이터');
  });

  it('패키지 버전을 제공한다', () => {
    expect(createProgram().version()).toBe(CLI_VERSION);
  });

  it('로컬 웹 UI 명령을 제공한다', () => {
    const uiCommand = createProgram().commands.find((command) => command.name() === 'ui');

    expect(uiCommand).toBeDefined();
    expect(uiCommand?.description()).toContain('로컬 웹 UI');
    expect(uiCommand?.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      '--host',
      '--port',
      '--project',
      '--data-dir',
      '--no-open',
      '--allow-remote',
    ]));
  });

  it('전체 배포 가능 메타데이터 비교 옵션을 제공한다', () => {
    const compareCommand = createProgram().commands.find((command) => command.name() === 'compare');

    expect(compareCommand?.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      '--all-metadata',
      '--metadata-type',
      '--wait',
    ]));
  });

  it('전체 배포 가능 메타데이터 배포 옵션을 제공한다', () => {
    const deployCommand = createProgram().commands.find((command) => command.name() === 'deploy');

    expect(deployCommand?.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      '--all-metadata',
      '--metadata-type',
    ]));
  });

  it('잘못된 UI 포트 환경변수는 UI 명령에서만 검증한다', async () => {
    vi.stubEnv('SFUD_UI_PORT', 'not-a-port');

    expect(() => createProgram()).not.toThrow();
    expect(createProgram().version()).toBe(CLI_VERSION);
    await expect(createProgram().parseAsync(['node', 'sfud', 'ui', '--no-open']))
      .rejects.toThrow(/포트는 1부터 65535/u);
  });
});
