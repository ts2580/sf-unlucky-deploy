import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createWebServer } from '../src/web/server/app.js';
import type { ComponentDifference } from '../src/metadata/comparator.js';

async function download(page: Page, dropdown: ReturnType<Page['getByRole']>, format = 'md') {
  await dropdown.click();
  const pending = page.waitForEvent('download');
  await dropdown.selectOption(format);
  await dropdown.press('Escape');
  await expect(dropdown).toHaveValue('');
  const file = await pending;
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

for (const width of [1440, 390]) {
  test(`현재 필터의 모든 페이지와 개별 파일 diff를 CSV·MD·JSON으로 다운로드한다 (${width}px)`, async ({ page }) => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'markdown-test-password', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
    const source = { id: 'project:fixture', kind: 'local' as const, label: '개발 Source' };
    const target = { id: 'org:target', kind: 'org' as const, label: '운영 Target', orgIdentityFingerprint: 'b'.repeat(64) };
    const errors: string[] = []; const submissions: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (entry) => { if (entry.type() === 'error') errors.push(entry.text()); });
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/deployments/')) submissions.push(request.url()); });
    const components: ComponentDifference[] = Array.from({ length: 23 }, (_, index) => {
      const name = index === 0 ? 'First' : index === 22 ? 'Last' : `Class${index}`;
      return { key: `ApexClass:${name}`, fullName: name, type: 'ApexClass', status: 'MODIFIED',
        files: [{ path: `classes/${name}.cls`, kind: 'text', status: 'MODIFIED', unifiedDiff: `@@ -1 +1 @@\n-이전 ${name}\n+변경 ${name}` }] };
    });
    components[0]!.files.push({ path: 'classes/First.cls-meta.xml', kind: 'xml', status: 'MODIFIED',
      xmlChanges: [{ kind: 'MODIFIED', path: 'ApexClass.status', before: 'Inactive', after: 'Active' }], diffTruncated: true,
      rawContentChanged: true, xmlSemanticStatus: 'DIFFERENT', xmlComparisonPolicy: 'GENERIC' });
    components[0]!.files.push({ path: 'staticresources/logo.png', kind: 'binary', status: 'MODIFIED', leftSha256: 'target-sha', rightSha256: 'source-sha', leftSize: 12, rightSize: 34 });
    const job = { id: 'markdown-fixture', status: 'SUCCEEDED', mode: 'compare', scope: 'all', metadataType: 'ApexClass', manifest: 'ApexClass', left: target, right: source,
      result: { components, warnings: ['등록된 XML semantic 정책이 없어 generic 비교를 사용한 metadata type: ApexClass', '상세 diff 일부를 생략했습니다.'], summary: { total: 23, added: 0, removed: 0, modified: 23, identical: 0, different: 23 } } };
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: { orgs: [{ ...target, alias: 'target', connected: true }], projects: [{ id: 'fixture', displayName: 'fixture', manifests: [] }], sources: [source, target] } }));
      await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }] } }));
      await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
      await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
      await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { drafts: [] }
        : { id: 'markdown-draft', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-11T01:00:00Z' } }));
      await page.route('**/api/v1/comparisons', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { jobs: [] } : { job: { ...job, mode: route.request().postDataJSON().sourceOnly ? 'source' : 'compare' } } }));
      await page.goto(`${address}/deploy`);
      await page.getByLabel('접속 비밀번호').fill('markdown-test-password');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      const exportDropdown = page.getByRole('combobox', { name: 'Diff 다운로드', exact: true });
      await expect(exportDropdown).toBeVisible();
      await expect(page.locator('.comparison-result')).not.toContainText('generic 비교');
      await expect(page.getByText('상세 diff 일부를 생략했습니다.', { exact: true })).toBeVisible();
      await expect(page.locator('.component-result')).toHaveCount(20);
      const all = await download(page, exportDropdown);
      expect(all.name).toBe('sfud-comparison-markdown-fixture-diff.md');
      expect(all.text).toContain('SOURCE: ` 개발 Source `');
      expect(all.text).toContain('TARGET: ` 운영 Target `');
      expect(all.text).toContain('`-` TARGET · `+` SOURCE');
      expect(all.text).toContain('컴포넌트 23개 · 모든 페이지');
      expect(all.text).toContain('+변경 Last');
      await page.getByRole('searchbox', { name: '메타데이터 검색', exact: true }).fill('Last');
      const filtered = await download(page, exportDropdown);
      expect(filtered.text).toContain('+변경 Last'); expect(filtered.text).not.toContain('+변경 First');
      expect(filtered.text).toContain('컴포넌트 1개 · 모든 페이지');
      for (const format of ['csv', 'json']) {
        const exported = await download(page, exportDropdown, format);
        expect(exported.name).toBe(`sfud-comparison-markdown-fixture-diff.${format}`);
        expect(exported.text).toContain('+변경 Last');
        expect(exported.text).not.toContain('+변경 First');
        if (format === 'json') expect(JSON.parse(exported.text).components).toHaveLength(1);
      }
      await page.getByRole('searchbox', { name: '메타데이터 검색', exact: true }).fill('missing-component');
      await expect(exportDropdown).toBeDisabled();
      await page.getByRole('searchbox', { name: '메타데이터 검색', exact: true }).fill('');
      for (const format of ['csv', 'json']) {
        const exported = await download(page, exportDropdown, format);
        expect(exported.text).toContain('+변경 Last');
        expect(exported.text).toContain('+변경 First');
        if (format === 'json') expect(JSON.parse(exported.text).components).toHaveLength(23);
      }
      await page.locator('.component-result').first().locator('summary').click();
      const textPanel = page.getByRole('region', { name: 'classes/First.cls Source와 Target 차이' });
      const single = await download(page, textPanel.getByRole('combobox', { name: '이 파일 다운로드', exact: true }));
      expect(single.name).toBe('sfud-First.cls-diff.md');
      expect(single.text).toContain('+변경 First'); expect(single.text).not.toContain('+변경 Last');
      const xmlPanel = page.getByRole('region', { name: 'classes/First.cls-meta.xml Source와 Target 차이' });
      await expect(xmlPanel).toContainText('파일 내용이 변경되었습니다.');
      await expect(xmlPanel).not.toContainText('generic 정책');
      const xml = await download(page, xmlPanel.getByRole('combobox', { name: '이 파일 다운로드', exact: true }));
      expect(xml.text).toContain('SOURCE:\n\n```text\nActive\n```');
      expect(xml.text).toContain('TARGET:\n\n```text\nInactive\n```');
      expect(xml.text).toContain('diff 일부가 생략');
      const binaryPanel = page.getByRole('region', { name: 'staticresources/logo.png Source와 Target 차이' });
      const binary = await download(page, binaryPanel.getByRole('combobox', { name: '이 파일 다운로드', exact: true }));
      expect(binary.text).toContain('SOURCE SHA-256: ` source-sha ` · 34 bytes');
      for (const [panel, filename] of [[textPanel, 'First.cls'], [xmlPanel, 'First.cls-meta.xml'], [binaryPanel, 'logo.png']] as const) {
        for (const format of ['csv', 'json']) {
          const exported = await download(page, panel.getByRole('combobox', { name: '이 파일 다운로드', exact: true }), format);
          expect(exported.name).toBe(`sfud-${filename}-diff.${format}`);
          expect(exported.text).toContain(filename);
          expect(exported.text).not.toContain('+변경 Last');
          if (format === 'json') expect(JSON.parse(exported.text).sourceSide).toBe('after');
        }
      }
      await textPanel.screenshot({ path: test.info().outputPath(`diff-download-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await page.getByRole('checkbox', { name: /현재 타입 비교 실행/u }).uncheck();
      await page.getByRole('button', { name: '메타데이터 다운로드', exact: true }).click();
      await expect(page.getByText('받아오기 완료', { exact: true })).toBeVisible();
      await expect(exportDropdown).toHaveCount(0);
      expect(errors).toEqual([]); expect(submissions).toEqual([]);
    } finally { await page.context().close(); await app.close(); }
  });
}
