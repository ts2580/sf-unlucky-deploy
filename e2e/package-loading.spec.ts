import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';
import { writeFixtureFiles } from '../test/support/files.js';

for (const width of [1440, 390]) {
  test(`패키지 병렬 로딩·실패 재시도·구성요소 검색·개별 제외 (${width}px)`, async ({ page }, testInfo) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-browser-'));
    let fail = true;
    let version = '04t000000000001';
    let finished = 0;
    let cancelled = 0;
    let activeRetrievals = 0;
    let peakRetrievals = 0;
    const retrievedNames: string[] = [];
    let release: (() => void) | undefined;
    let started = false;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const componentRequests: string[] = [];
    page.on('request', (request) => {
      const match = /\/installed-packages\/(033[A-Za-z0-9]+)\/components$/u.exec(new URL(request.url()).pathname);
      if (match) componentRequests.push(match[1]!);
    });
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      databasePath: path.join(root, 'state.db'), assetsDirectory: path.resolve('dist/ui'),
      sfClient: { async runJson(args, options) {
        if (args[0] === 'org' && args.includes('metadata-types')) return { result: { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes', suffix: 'cls' }] } };
        if (args[0] === 'org') return { result: { nonScratchOrgs: [
          { alias: 'dev', username: 'dev@example.com', connectedStatus: 'Connected' },
          { alias: 'other', username: 'other@example.com', connectedStatus: 'Connected' },
        ] } };
        if (args[0] === 'data') return { result: { records: [] } };
        if (args[0] === 'package') return { result: args.at(-1) === 'other' ? [] : [
          { SubscriberPackageId: '033000000000001', SubscriberPackageVersionId: version, SubscriberPackageName: 'Unlocked CRM', SubscriberPackageNamespace: null },
          { SubscriberPackageId: '033000000000002', SubscriberPackageVersionId: version, SubscriberPackageName: 'Unique CRM', SubscriberPackageNamespace: 'unique' },
          { SubscriberPackageId: '033000000000003', SubscriberPackageVersionId: version, SubscriberPackageName: 'Shared A', SubscriberPackageNamespace: 'shared' },
          { SubscriberPackageId: '033000000000004', SubscriberPackageVersionId: version, SubscriberPackageName: 'Shared B', SubscriberPackageNamespace: 'shared' },
          { SubscriberPackageId: '033000000000005', SubscriberPackageVersionId: version, SubscriberPackageName: 'ZQueued CRM', SubscriberPackageNamespace: null },
        ] };
        if (args.includes('--package-name')) {
          const name = args[args.indexOf('--package-name') + 1]!;
          if (!['Unlocked CRM', 'Shared A', 'Shared B', 'ZQueued CRM'].includes(name)) throw new Error('고유 네임스페이스는 조회하면 안 됩니다.');
          retrievedNames.push(name);
          activeRetrievals++;
          peakRetrievals = Math.max(peakRetrievals, activeRetrievals);
          if (name === 'Unlocked CRM') started = true;
          let abort = () => {};
          try {
            await Promise.race([gate, new Promise<never>((_resolve, reject) => {
              abort = () => { cancelled += 1; reject(options.signal!.reason); };
              options.signal?.addEventListener('abort', abort, { once: true });
              if (options.signal?.aborted) abort();
            })]);
            if (fail && name === 'Unlocked CRM') throw new Error('패키지 조회 권한을 확인하세요.');
            const members = name === 'Unlocked CRM' ? '<members>OwnedClass</members><members>SecondClass</members>'
              : `<members>${name === 'ZQueued CRM' ? 'QueuedClass' : name.endsWith('A') ? 'shared__First' : 'shared__Second'}</members>`;
            await writeFixtureFiles(path.join(args[args.indexOf('--target-metadata-dir') + 1]!, name), {
              'package.xml': `<Package><types>${members}<name>ApexClass</name></types><version>67.0</version></Package>`,
            });
            if (name === 'Unlocked CRM') finished += 1;
            return { result: { success: true, done: true } };
          } finally { activeRetrievals--; options.signal?.removeEventListener('abort', abort); }
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
      const unique = panel.getByRole('checkbox', { name: 'Unique CRM 비교에서 제외' });
      const sharedA = panel.getByRole('checkbox', { name: 'Shared A 비교에서 제외' });
      const sharedB = panel.getByRole('checkbox', { name: 'Shared B 비교에서 제외' });
      await expect(unique).toBeEnabled();
      await expect(sharedA).toBeDisabled();
      await expect(sharedB).toBeDisabled();
      await unique.check();
      await expect(page.locator('.package-exclusions-summary')).toContainText('1개 패키지 제외');
      await unique.uncheck();
      const load = panel.getByRole('button', { name: '패키지 로딩', exact: true });
      const all = panel.getByRole('checkbox', { name: '전체 패키지 제외', exact: true });
      await expect(all).not.toBeChecked();
      const row = page.locator('.comparison-controls-row');
      expect(Math.abs((await row.boundingBox())!.width - (await panel.boundingBox())!.width)).toBeLessThan(2);
      const searchSpacing = await page.locator('.deploy-search-panel').evaluate((element) => {
        const button = element.querySelector('.comparison-run-actions')!;
        return element.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom - parseFloat(getComputedStyle(element).paddingBottom);
      });
      expect(searchSpacing).toBeLessThan(2);
      await all.click();
      await expect.poll(() => started).toBe(true);
      await expect.poll(() => activeRetrievals).toBe(3);
      expect(retrievedNames).toHaveLength(3);
      expect(retrievedNames).not.toContain('ZQueued CRM');
      const busy = panel.getByRole('button', { name: '패키지 로딩 중……', exact: true });
      await expect(busy).toBeDisabled();
      await expect(all).toBeDisabled();
      await expect(busy).toHaveAttribute('aria-busy', 'true');
      await expect(panel.getByRole('status')).toContainText('0/4 처리');
      for (const name of ['Shared A', 'Shared B', 'Unlocked CRM']) await expect(panel.getByRole('status')).toContainText(name);
      expect(await busy.locator('svg').evaluate((element) => getComputedStyle(element).animationName)).toBe('spin');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`package-loading-${width}.png`), fullPage: true });
      release!();
      await expect(panel.getByRole('alert').filter({ hasText: '패키지 조회 권한' })).toBeVisible();
      await expect(panel.getByRole('alert').filter({ hasText: '전체 제외를 적용하지 않았습니다' })).toBeVisible();
      await expect(all).not.toBeChecked();
      await expect(load).toBeEnabled();
      await expect(panel.getByText('ZQueued CRM 구성요소 보기 (1개)', { exact: true })).toBeVisible();
      expect(peakRetrievals).toBe(3);
      await expect(checkbox).toBeDisabled();
      fail = false;
      await all.click();
      await expect(checkbox).toBeEnabled();
      await expect(all).toBeChecked();
      await expect(page.locator('.package-exclusions-summary')).toContainText('5개 패키지 제외');
      for (const name of ['Unlocked CRM', 'Unique CRM', 'Shared A', 'Shared B', 'ZQueued CRM']) {
        await expect(panel.getByRole('checkbox', { name: `${name} 비교에서 제외`, exact: true })).toBeChecked();
      }
      await all.click();
      await expect(all).not.toBeChecked();
      await expect(checkbox).not.toBeChecked();
      await expect(panel.getByRole('alert')).toHaveCount(0);
      expect(new Set(componentRequests)).toEqual(new Set(['033000000000001', '033000000000003', '033000000000004', '033000000000005']));
      await expect(sharedA).toBeEnabled();
      await expect(sharedB).toBeEnabled();
      await sharedA.check();
      await expect(all).toHaveJSProperty('indeterminate', true);
      await expect(sharedB).not.toBeChecked();
      await expect(page.locator('.package-exclusions-summary')).toContainText('1개 패키지 제외');
      await sharedA.uncheck();
      await expect(panel).toContainText('구성요소 2개 로딩 완료');
      await panel.getByText('Unlocked CRM 구성요소 보기 (2개)', { exact: true }).click();
      const memberList = panel.locator('.package-members').filter({ hasText: 'Unlocked CRM 구성요소 보기' });
      await expect(memberList.getByRole('listitem')).toHaveCount(2);
      await panel.getByLabel('Unlocked CRM 구성요소 검색').fill('Owned');
      await expect(memberList.getByRole('listitem')).toHaveCount(1);
      await expect(memberList.getByRole('listitem')).toContainText('ApexClass · OwnedClass');
      await checkbox.check();
      await expect(page.locator('.package-exclusions-summary')).toContainText('1개 패키지 제외');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`package-loaded-${width}.png`), fullPage: true });
      // Changing Orgs cancels the server-side retrieval, not just its UI response.
      version = '04t000000000002';
      started = false;
      gate = new Promise<void>((resolve) => { release = resolve; });
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:other');
      await page.getByLabel('TARGET 비교 소스').selectOption('org:other');
      if (!(await page.locator('.package-exclusions').evaluate((element) => (element as HTMLDetailsElement).open))) await page.locator('.package-exclusions-summary').click();
      await expect(panel).toContainText('설치된 패키지가 없습니다.');
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:dev');
      await page.getByLabel('TARGET 비교 소스').selectOption('org:dev');
      if (!(await page.locator('.package-exclusions').evaluate((element) => (element as HTMLDetailsElement).open))) await page.locator('.package-exclusions-summary').click();
      await expect(checkbox).toBeDisabled();
      await expect(all).toBeEnabled();
      await all.click();
      await expect.poll(() => started).toBe(true);
      await expect.poll(() => activeRetrievals).toBe(3);
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:other');
      // Select the same target as source so the inventory now contains only the other Org.
      await page.getByLabel('TARGET 비교 소스').selectOption('org:other');
      await expect.poll(() => cancelled).toBe(3);
      await expect.poll(() => activeRetrievals).toBe(0);
      expect(retrievedNames.filter((name) => name === 'ZQueued CRM')).toHaveLength(1);
      release!();
      expect(finished).toBe(1);
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
