import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 390, 2560]) {
  test(`비교 결과와 큰 파일 목록의 높이를 제한하고 페이지 이동을 유지한다 (${width}px)`, async ({ page }, testInfo) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-result-scroll-'));
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      databasePath: path.join(root, 'state.db'), assetsDirectory: path.resolve('dist/ui'),
      sfClient: { async runJson(args) {
        if (args.includes('metadata-types')) return { result: { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes', suffix: 'cls' }] } };
        if (args[0] === 'org' && args.includes('metadata')) return { result: [] };
        if (args[0] === 'org') return { result: { nonScratchOrgs: ['source', 'target'].map((alias) => ({
          alias, username: `${alias}@example.com`, connectedStatus: 'Connected',
        })) } };
        if (args[0] === 'package') return { result: [] };
        if (args[0] === 'data') return { result: { records: [] } };
        throw new Error(`예상하지 못한 호출: ${args.join(' ')}`);
      } },
    });
    const components = Array.from({ length: 201 }, (_, index) => {
      const fullName = `Paged${String(index + 1).padStart(3, '0')}`;
      return { key: `ApexClass:${fullName}`, type: 'ApexClass', fullName, status: 'MODIFIED',
        files: Array.from({ length: index === 0 ? 30 : 1 }, (_, file) => ({
          path: `classes/${fullName}-${file}.cls`, status: 'MODIFIED', kind: 'text',
          unifiedDiff: '--- target\n+++ source\n@@ -1 +1 @@\n-old\n+new\n',
        })),
      };
    });
    const job = { id: 'scroll-comparison', status: 'SUCCEEDED', scope: 'all', metadataType: 'ApexClass', manifest: 'ApexClass',
      left: { id: 'org:target', kind: 'org', label: 'target' }, right: { id: 'org:source', kind: 'org', label: 'source' },
      result: { summary: { added: 0, removed: 0, modified: 201, identical: 0, total: 201, different: 201 }, warnings: [], components } };
    await page.route('**/api/v1/comparisons**', (route) => route.fulfill({
      status: route.request().method() === 'POST' ? 202 : 200,
      json: route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/v1/comparisons' ? { jobs: [] } : { job },
    }));
    await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: {
      testClasses: [{ name: 'Paged001_Test', matchesConfiguredSuffix: true }],
    } }));
    // The synthetic comparison uses Org IDs without real authentication records.
    // Keep draft saving successful so its unrelated error banner cannot change the measured height.
    await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ json: route.request().method() === 'PUT'
      ? { id: 'scroll-draft', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }
      : { drafts: [] } }));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:source');
      await page.getByLabel('TARGET 비교 소스').selectOption('org:target');
      await expect(page.getByRole('button', { name: '메타데이터 비교', exact: true })).toBeEnabled();
      const before = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      const result = page.locator('.comparison-result');
      await expect(result.locator('.component-result')).toHaveCount(20);
      const resultBox = (await result.boundingBox())!;
      expect(resultBox.height).toBeLessThan(900 * 0.6 + 650);
      expect(await page.evaluate(() => document.documentElement.scrollHeight) - before).toBeLessThan(1400);
      const list = page.getByRole('region', { name: '메타데이터 검색 결과 목록', exact: true });
      expect((await list.boundingBox())!.height).toBeLessThanOrEqual(542);
      expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      const pagination = page.getByRole('navigation', { name: '메타데이터 검색 결과 페이지' });
      await expect(list.getByRole('navigation')).toHaveCount(0);
      const paginationGap = await page.evaluate(() => {
        const listBox = document.querySelector('.component-results-list')!.getBoundingClientRect();
        const navigationBox = document.querySelector('.component-pagination')!.getBoundingClientRect();
        return navigationBox.top - listBox.bottom;
      });
      expect(paginationGap).toBeGreaterThanOrEqual(0);
      await page.getByLabel('Paged001 배포 대상으로 선택').check();
      await expect(page.getByRole('region', { name: 'Apex 테스트 클래스 선택' })
        .getByRole('checkbox', { name: 'Paged001_Test' })).toBeVisible();
      const collapsedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await list.locator('.component-result summary > div').first().click();
      await expect(list.locator('.component-result').first()).toHaveAttribute('open', '');
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(collapsedHeight + 2);
      await list.focus();
      await list.press('End');
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await pagination.getByRole('button', { name: '2 페이지', exact: true }).click();
      await expect(page.getByText('Paged021', { exact: true })).toBeVisible();
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
      await pagination.getByRole('button', { name: '1 페이지', exact: true }).click();
      await expect(page.getByLabel('Paged001 배포 대상으로 선택')).toBeChecked();
      await page.getByRole('searchbox', { name: '메타데이터 검색', exact: true }).fill('Paged201');
      await expect(result.locator('.component-result')).toHaveCount(1);
      await expect(pagination).toHaveCount(0);
      await page.getByRole('searchbox', { name: '메타데이터 검색', exact: true }).fill('');
      await expect(result.locator('.component-result')).toHaveCount(20);
      await expect(page.getByLabel('Paged001 배포 대상으로 선택')).toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(errors).toEqual([]);
      await result.screenshot({ path: testInfo.outputPath(`comparison-scroll-${width}.png`) });
    } finally { await page.context().close(); await app.close(); await rm(root, { recursive: true, force: true }); }
  });
}
