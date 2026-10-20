import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from '../test/support/files.js';

for (const width of [1440, 390]) {
  test(`패키지 로딩·실패 재시도·구성요소 검색·개별 제외 (${width}px)`, async ({ page }, testInfo) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-browser-'));
    let fail = true;
    let version = '04t000000000001';
    let finished = 0;
    let release: (() => void) | undefined;
    let started = false;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      databasePath: path.join(root, 'state.db'), assetsDirectory: path.resolve('dist/ui'),
      sfClient: { async runJson(args) {
        if (args[0] === 'org' && args.includes('metadata-types')) return { result: { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes', suffix: 'cls' }] } };
        if (args[0] === 'org') return { result: { nonScratchOrgs: [
          { alias: 'dev', username: 'dev@example.com', connectedStatus: 'Connected' },
          { alias: 'other', username: 'other@example.com', connectedStatus: 'Connected' },
        ] } };
        if (args[0] === 'data') return { result: { records: [] } };
        if (args[0] === 'package') return { result: args.at(-1) === 'other' ? [] : [{ SubscriberPackageId: '033000000000001', SubscriberPackageVersionId: version, SubscriberPackageName: 'Unlocked CRM', SubscriberPackageNamespace: null }] };
        if (args.includes('--package-name')) {
          started = true;
          await gate;
          if (fail) throw new Error('패키지 조회 권한을 확인하세요.');
          await writeFixtureFiles(path.join(args[args.indexOf('--target-metadata-dir') + 1]!, 'Unlocked CRM'), {
            'package.xml': '<Package><types><members>OwnedClass</members><members>SecondClass</members><name>ApexClass</name></types><version>67.0</version></Package>',
          });
          finished += 1;
          return { result: { success: true, done: true } };
        }
        throw new Error(`예상하지 못한 호출: ${args.join(' ')}`);
      } },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:dev');
      await page.locator('.package-exclusions-summary').click();
      const panel = page.getByRole('group', { name: '비교에서 제외할 설치 패키지' });
      const checkbox = panel.getByRole('checkbox', { name: 'Unlocked CRM 비교에서 제외' });
      await expect(checkbox).toBeDisabled();
      const load = panel.getByRole('button', { name: '패키지 로딩', exact: true });
      await load.click();
      await expect.poll(() => started).toBe(true);
      const busy = panel.getByRole('button', { name: '패키지 로딩 중……', exact: true });
      await expect(busy).toBeDisabled();
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await expect(panel.getByRole('status')).toContainText('1/1');
      expect(await busy.locator('svg').evaluate((element) => getComputedStyle(element).animationName)).toBe('spin');
      release!();
      await expect(panel.getByRole('alert')).toContainText('패키지 조회 권한');
      await expect(checkbox).toBeDisabled();
      fail = false;
      await load.click();
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).not.toBeChecked();
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel).toContainText('구성요소 2개 로딩 완료');
      await panel.getByText('Unlocked CRM 구성요소 보기 (2개)', { exact: true }).click();
      await expect(panel.getByRole('listitem')).toHaveCount(2);
      await panel.getByLabel('Unlocked CRM 구성요소 검색').fill('Owned');
      await expect(panel.getByRole('listitem')).toHaveCount(1);
      await expect(panel.getByRole('listitem')).toContainText('ApexClass · OwnedClass');
      await checkbox.check();
      await expect(page.locator('.package-exclusions-summary')).toContainText('1개 패키지 제외');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`package-loaded-${width}.png`), fullPage: true });
      // A late response from a previous Org selection must not repopulate the panel.
      version = '04t000000000002';
      started = false;
      gate = new Promise<void>((resolve) => { release = resolve; });
      await load.click();
      await expect.poll(() => started).toBe(true);
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:other');
      // Select the same target as source so the inventory now contains only the other Org.
      await page.getByLabel('TARGET 비교 소스').selectOption('org:other');
      release!();
      await expect.poll(() => finished).toBe(2);
      await expect(page.locator('.package-exclusions-summary')).toContainText('패키지를 선택해 비교에서 제외');
      if (!(await page.locator('.package-exclusions').evaluate((element) => (element as HTMLDetailsElement).open))) {
        await page.locator('.package-exclusions-summary').click();
      }
      await expect(panel).toContainText('설치된 패키지가 없습니다.');
      await expect(panel.getByText('Unlocked CRM 구성요소 보기 (2개)', { exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { release?.(); await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
  });
}
