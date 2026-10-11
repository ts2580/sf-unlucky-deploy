import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 390]) {
  test(`배포 대상 선택 전에 테스트 후보를 표시하고 소스 변경·만료를 반영한다 (${width}px)`, async ({ page }) => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'apex-picker-test', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
    const source = { id: 'project:first', kind: 'local', label: 'First source' };
    const second = { id: 'project:second', kind: 'local', label: 'Second source' };
    const expired = { id: 'git:expired', kind: 'local', location: 'git', label: 'Expired source' };
    const target = { id: 'org:target', kind: 'org', label: 'Target' };
    const loadedSources: string[] = []; const submissions: string[] = []; const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/(comparisons|deployments)(\/|$)/u.test(new URL(request.url()).pathname)) submissions.push(request.url());
    });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: { orgs: [{ ...target, alias: 'target', connected: true }], projects: [], sources: [source, second, expired, target] } }));
      await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }] } }));
      await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
      await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { drafts: [] }
        : { id: 'picker-draft', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-11T01:00:00Z' } }));
      await page.route('**/api/v1/apex-test-classes**', (route) => {
        const sourceId = new URL(route.request().url()).searchParams.get('sourceId')!;
        loadedSources.push(sourceId);
        return route.fulfill({ json: sourceId === expired.id
          ? { error: { code: 'APEX_TEST_CLASSES_LOAD_FAILED', message: '가져온 소스가 만료되었습니다. 다시 가져오세요.' } }
          : { testClasses: [{ name: sourceId === source.id ? 'First_Test' : 'Second_Test', matchesConfiguredSuffix: true }] },
        status: sourceId === expired.id ? 400 : 200 });
      });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('접속 비밀번호').fill('apex-picker-test');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      const picker = page.getByRole('region', { name: 'Apex 테스트 클래스 선택' });
      const directInput = page.getByLabel('테스트 클래스 직접 입력');
      await expect(picker.getByRole('checkbox', { name: 'First_Test' })).toBeVisible();
      await expect(directInput).not.toBeFocused();
      await expect(page.getByRole('complementary', { name: '배포 대상' })).toContainText('선택된 배포 대상이 없습니다');
      await picker.getByRole('checkbox', { name: 'First_Test' }).check();
      await expect(directInput).toHaveValue('First_Test');
      await directInput.focus();
      await directInput.press('Tab');
      expect(loadedSources).toEqual([source.id]);

      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(expired.id);
      await expect(picker).toContainText('가져온 소스가 만료되었습니다. 다시 가져오세요. 직접 입력은 계속 사용할 수 있습니다.');
      await expect(picker.getByRole('checkbox')).toHaveCount(0);
      await directInput.fill('Manual_Test');
      await expect(directInput).toHaveValue('Manual_Test');

      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(second.id);
      await expect(picker.getByRole('checkbox', { name: 'Second_Test' })).toBeVisible();
      await expect(picker).not.toContainText('만료');
      await expect(picker.getByRole('checkbox', { name: 'First_Test' })).toHaveCount(0);
      expect(loadedSources).toEqual([source.id, expired.id, second.id]);
      expect(submissions).toEqual([]); expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await picker.screenshot({ path: test.info().outputPath(`apex-picker-${width}.png`) });
    } finally { await page.context().close(); await app.close(); }
  });
}
