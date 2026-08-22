import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SfudError } from '../src/core/errors.js';
import { parseSourceSpec } from '../src/sources/source-spec.js';

describe('source spec', () => {
  it('org 별칭을 해석한다', () => {
    expect(parseSourceSpec('org:dev')).toEqual({
      kind: 'org',
      alias: 'dev',
      displayName: 'org:dev',
    });
  });

  it('로컬 경로를 절대 경로로 해석한다', () => {
    const source = parseSourceSpec('local:../project', '/workspace/current');
    expect(source).toEqual({
      kind: 'local',
      projectPath: path.resolve('/workspace/current', '../project'),
      displayName: `local:${path.resolve('/workspace/current', '../project')}`,
    });
  });

  it('지원하지 않는 형식을 거부한다', () => {
    expect(() => parseSourceSpec('remote:dev')).toThrowError(SfudError);
    expect(() => parseSourceSpec('org:')).toThrowError(SfudError);
    expect(() => parseSourceSpec('dev')).toThrowError(SfudError);
  });
});
