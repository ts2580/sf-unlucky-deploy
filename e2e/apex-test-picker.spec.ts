import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 390]) {
  test(`ApexClass 배포 대상이 있을 때만 테스트 설정을 표시하고 소스 변경·만료를 반영한다 (${width}px)`, async ({ page }) => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'apex-picker-test', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
    const source = { id: 'project:first', kind: 'local', label: 'First source' };
    const second = { id: 'project:second', kind: 'local', label: 'Second source' };
    const expired = { id: 'project:expired', kind: 'local', label: 'Expired source' };
    const target = { id: 'org:target', kind: 'org', label: 'Target' };
    const loadedSources: string[] = []; const errors: string[] = [];
    let dryRunBody: Record<string, unknown> | undefined;
    page.on('pageerror', (error) => errors.push(error.message));
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
      await page.route('**/api/v1/comparisons**', (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
        const right = { ...source, id: route.request().postDataJSON().rightSourceId };
        const components = [{ type: 'ApexClass', fullName: 'Hello' }, { type: 'CustomLabels', fullName: 'CustomLabels' }, { type: 'ApexTrigger', fullName: 'HelloTrigger' }]
          .map((item) => ({ ...item, key: `${item.type}:${item.fullName}`, status: 'MODIFIED', files: [] }));
        return route.fulfill({ status: 202, json: { job: { id: `picker-${right.id}`, status: 'SUCCEEDED', scope: 'all', manifest: 'ApexClass',
          left: target, right, result: { summary: { total: 3, modified: 3, added: 0, removed: 0, identical: 0, different: 3 }, components, warnings: [] } } } });
      });
      await page.route('**/api/v1/deployments/dry-run', (route) => {
        dryRunBody = route.request().postDataJSON();
        return route.fulfill({ status: 400, json: { error: { code: 'FIXTURE_STOP', message: '요청 확인 완료' } } });
      });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('접속 비밀번호').fill('apex-picker-test');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      const picker = page.getByRole('region', { name: 'Apex 테스트 클래스 선택' });
      const directInput = page.getByLabel('테스트 클래스 직접 입력');
      const settings = page.getByRole('region', { name: 'Apex 테스트 설정', exact: true });
      await expect(settings).toHaveCount(0);
      expect(loadedSources).toEqual([]);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      await page.getByLabel('CustomLabels 배포 대상으로 선택').check();
      await page.getByLabel('HelloTrigger 배포 대상으로 선택').check();
      await expect(settings).toHaveCount(0);
      expect(loadedSources).toEqual([]);
      await page.getByLabel('Hello 배포 대상으로 선택').check();
      await expect(picker.getByRole('checkbox', { name: 'First_Test' })).toBeVisible();
      await expect(directInput).not.toBeFocused();
      await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeEnabled();
      await picker.getByRole('checkbox', { name: 'First_Test' }).check();
      await expect(directInput).toHaveValue('First_Test');
      await directInput.focus();
      await directInput.press('Tab');
      expect(loadedSources).toEqual([source.id]);

      await page.getByLabel('테스트 수준').selectOption('RunSpecifiedTests');
      await directInput.clear();
      await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeDisabled();
      await page.getByLabel('Hello 배포 대상으로 선택').uncheck();
      await expect(settings).toHaveCount(0);
      await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeEnabled();
      await page.getByRole('button', { name: '배포 대상 Dry-run' }).click();
      await expect.poll(() => dryRunBody).toMatchObject({ testLevel: 'auto', tests: [], components: [
        { type: 'ApexTrigger', fullName: 'HelloTrigger' }, { type: 'CustomLabels', fullName: 'CustomLabels' },
      ] });
      await page.getByLabel('Hello 배포 대상으로 선택').check();
      await expect(page.getByLabel('테스트 수준')).toHaveValue('RunSpecifiedTests');
      await page.getByLabel('테스트 수준').selectOption('auto');
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(expired.id);
      await expect(settings).toHaveCount(0);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      await page.getByLabel('Hello 배포 대상으로 선택').check();
      await expect(picker).toContainText('가져온 소스가 만료되었습니다. 다시 가져오세요. 직접 입력은 계속 사용할 수 있습니다.');
      await expect(picker.getByRole('checkbox')).toHaveCount(0);
      await directInput.fill('Manual_Test');
      await expect(directInput).toHaveValue('Manual_Test');

      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(second.id);
      await expect(settings).toHaveCount(0);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      await page.getByLabel('Hello 배포 대상으로 선택').check();
      await expect(picker.getByRole('checkbox', { name: 'Second_Test' })).toBeVisible();
      await expect(picker).not.toContainText('만료');
      await expect(picker.getByRole('checkbox', { name: 'First_Test' })).toHaveCount(0);
      expect([...new Set(loadedSources)]).toEqual([source.id, expired.id, second.id]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await picker.screenshot({ path: test.info().outputPath(`apex-picker-${width}.png`) });
    } finally { await page.context().close(); await app.close(); }
  });
}
