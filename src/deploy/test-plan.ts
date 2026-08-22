import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { listFiles } from '../core/files.js';

export type SalesforceTestLevel =
  | 'NoTestRun'
  | 'RunSpecifiedTests'
  | 'RunLocalTests'
  | 'RunAllTestsInOrg'
  | 'RunRelevantTests';

export type RequestedTestLevel = 'auto' | SalesforceTestLevel;

export interface ApexTestPlan {
  level: SalesforceTestLevel;
  tests: string[];
  selection: 'explicit' | 'suffix' | 'fallback' | 'configured';
}

export async function selectApexTestPlan(
  packageRoot: string,
  requestedLevel: RequestedTestLevel = 'auto',
  requestedTests: readonly string[] = [],
): Promise<ApexTestPlan> {
  const explicitTests = normalizeTests(requestedTests);
  const suffixTests = await discoverSuffixTests(packageRoot);

  if (requestedLevel === 'auto') {
    if (explicitTests.length > 0) {
      return { level: 'RunSpecifiedTests', tests: explicitTests, selection: 'explicit' };
    }
    if (suffixTests.length > 0) {
      return { level: 'RunSpecifiedTests', tests: suffixTests, selection: 'suffix' };
    }
    return { level: 'RunLocalTests', tests: [], selection: 'fallback' };
  }

  if (requestedLevel === 'RunSpecifiedTests') {
    const tests = explicitTests.length > 0 ? explicitTests : suffixTests;
    if (tests.length === 0) {
      throw new SfudError(
        'INVALID_ARGUMENT',
        'RunSpecifiedTests에 사용할 --tests가 없고 staging에서 *_Test.cls도 찾지 못했습니다.',
      );
    }
    return {
      level: 'RunSpecifiedTests',
      tests,
      selection: explicitTests.length > 0 ? 'explicit' : 'suffix',
    };
  }

  if (explicitTests.length > 0) {
    throw new SfudError('INVALID_ARGUMENT', '--tests는 auto 또는 RunSpecifiedTests와 함께 사용해야 합니다.');
  }

  return { level: requestedLevel, tests: [], selection: 'configured' };
}

export async function discoverSuffixTests(packageRoot: string): Promise<string[]> {
  return (await listFiles(packageRoot))
    .filter((relativePath) => /^classes\/[^/]+_Test\.cls$/u.test(relativePath))
    .map((relativePath) => path.posix.basename(relativePath, '.cls'))
    .sort((left, right) => left.localeCompare(right));
}

function normalizeTests(tests: readonly string[]): string[] {
  const normalized = tests.map((test) => test.trim()).filter((test) => test.length > 0);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}
