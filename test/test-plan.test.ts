import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { selectApexTestPlan } from '../src/deploy/test-plan.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('Apex test plan', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('기본적으로 *_Test.cls를 정렬해 RunSpecifiedTests로 선택한다', async () => {
    const root = await fixtureRoot(temporaryDirectories, {
      'classes/Order_Test.cls': 'public class Order_Test {}',
      'classes/Account_Test.cls': 'public class Account_Test {}',
      'classes/Legacy_test.cls': 'public class Legacy_test {}',
      'classes/OrderService.cls': 'public class OrderService {}',
    });

    await expect(selectApexTestPlan(root)).resolves.toEqual({
      level: 'RunSpecifiedTests',
      tests: ['Account_Test', 'Legacy_test', 'Order_Test'],
      selection: 'suffix',
    });
  });

  it('명시한 테스트 클래스가 자동 선택보다 우선한다', async () => {
    const root = await fixtureRoot(temporaryDirectories, {
      'classes/Auto_Test.cls': 'public class Auto_Test {}',
    });

    await expect(selectApexTestPlan(root, 'auto', ['Manual_Test'])).resolves.toEqual({
      level: 'RunSpecifiedTests',
      tests: ['Manual_Test'],
      selection: 'explicit',
    });
  });

  it('설정한 접미사로 테스트 클래스를 대소문자 구분 없이 선택한다', async () => {
    const root = await fixtureRoot(temporaryDirectories, {
      'classes/AccountSpec.cls': 'public class AccountSpec {}',
      'classes/OrderSPEC.cls': 'public class OrderSPEC {}',
      'classes/Legacy_Test.cls': 'public class Legacy_Test {}',
    });

    await expect(selectApexTestPlan(root, 'auto', [], 'Spec')).resolves.toEqual({
      level: 'RunSpecifiedTests',
      tests: ['AccountSpec', 'OrderSPEC'],
      selection: 'suffix',
    });
  });

  it('*_Test.cls가 없으면 안전하게 RunLocalTests로 fallback한다', async () => {
    const root = await fixtureRoot(temporaryDirectories, {
      'classes/OrderService.cls': 'public class OrderService {}',
    });

    await expect(selectApexTestPlan(root)).resolves.toEqual({
      level: 'RunLocalTests',
      tests: [],
      selection: 'fallback',
    });
  });
});

async function fixtureRoot(
  temporaryDirectories: string[],
  files: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-test-plan-'));
  temporaryDirectories.push(root);
  await writeFixtureFiles(root, files);
  return root;
}
