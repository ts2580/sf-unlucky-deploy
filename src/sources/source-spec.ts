import path from 'node:path';

import { SfudError } from '../core/errors.js';

export type SourceSpec = OrgSourceSpec | LocalSourceSpec;

export interface OrgSourceSpec {
  kind: 'org';
  alias: string;
  displayName: string;
}

export interface LocalSourceSpec {
  kind: 'local';
  projectPath: string;
  displayName: string;
}

export function parseSourceSpec(value: string, cwd = process.cwd()): SourceSpec {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex < 1) {
    throw new SfudError('INVALID_SOURCE', `소스는 org:<alias> 또는 local:<path> 형식이어야 합니다: ${value}`);
  }

  const kind = value.slice(0, separatorIndex);
  const target = value.slice(separatorIndex + 1).trim();
  if (target.length === 0 || /[\u0000-\u001f]/u.test(target)) {
    throw new SfudError('INVALID_SOURCE', `유효하지 않은 소스 식별자입니다: ${value}`);
  }

  if (kind === 'org') {
    return {
      kind: 'org',
      alias: target,
      displayName: `org:${target}`,
    };
  }

  if (kind === 'local') {
    const projectPath = path.resolve(cwd, target);
    return {
      kind: 'local',
      projectPath,
      displayName: `local:${projectPath}`,
    };
  }

  throw new SfudError('INVALID_SOURCE', `지원하지 않는 소스 유형입니다: ${kind}`);
}
