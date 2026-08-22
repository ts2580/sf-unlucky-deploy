import { describe, expect, it } from 'vitest';

import { CLI_VERSION, createProgram } from '../src/program.js';

describe('sfud CLI', () => {
  it('이름과 설명을 제공한다', () => {
    const program = createProgram();

    expect(program.name()).toBe('sfud');
    expect(program.description()).toContain('Salesforce 메타데이터');
  });

  it('패키지 버전을 제공한다', () => {
    expect(createProgram().version()).toBe(CLI_VERSION);
  });
});
