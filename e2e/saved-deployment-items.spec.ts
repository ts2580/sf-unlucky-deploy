import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 390]) {
  test(`저장된 배포·테스트 목록을 조회 없이 표시하고 그대로 배포·비교한다 (${width}px)`, async ({ page }) => {
    let sfCalls = 0;
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'saved-items-test', databasePath: ':memory:',
      sfClient: { async runJson() { sfCalls++; return { result: { nonScratchOrgs: ['source', 'target'].map((alias, index) => ({
        alias, username: `${alias}@example.com`, orgId: `00D00000000000${index + 1}`, connectedStatus: 'Connected', isSandbox: true,
      })) } }; } } });
    const source = { id: 'org:source', kind: 'org' as const, label: 'source' };
    const target = { id: 'org:target', kind: 'org' as const, label: 'target' };
    const components = ['SavedClass', 'AnotherClass', 'UnselectedClass'].map((fullName) => ({ key: `ApexClass:${fullName}`, type: 'ApexClass', fullName, status: 'MODIFIED', files: [] }));
    const selected = components.slice(0, 2).map(({ type, fullName }) => ({ type, fullName })).sort((left, right) => left.fullName.localeCompare(right.fullName));
    const tests = ['Saved_Test', 'Another_Test'];
    const comparisons: Record<string, unknown>[] = []; const deployments: Record<string, unknown>[] = [];
    const errors: string[] = []; const reads: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { if (/\/(metadata-types|apex-test-classes|installed-packages)(\?|$)/u.test(request.url())) reads.push(request.url()); });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }] } }));
      await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
      await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
      await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { drafts: [] }
        : { id: 'items-draft', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-11T01:00:00Z' } }));
      await page.route('**/api/v1/comparisons', (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
        const body = route.request().postDataJSON(); comparisons.push(body);
        const items = body.scope === 'selected' ? components.slice(0, 2) : components;
        return route.fulfill({ status: 202, json: { job: { id: `items-${comparisons.length}`, status: 'SUCCEEDED', scope: 'all', metadataType: 'ApexClass',
          manifest: 'ApexClass', left: target, right: source, result: { components: items, warnings: [],
            summary: { total: items.length, added: 0, removed: 0, modified: items.length, identical: 0, different: items.length } } } } });
      });
      await page.route('**/api/v1/deployments/direct', (route) => {
        const body = route.request().postDataJSON(); deployments.push(body);
        return route.fulfill({ status: 202, json: { job: { id: 'saved-items-deployment', kind: 'DEPLOY', status: 'SUCCEEDED', source, target,
          manifest: '선택 항목', scope: 'selected', components: selected, prepared: true, remoteStatus: 'SUCCEEDED',
          testPlan: { level: 'RunSpecifiedTests', tests, selection: 'explicit' }, createdAt: '2026-10-11T01:00:00Z' } } });
      });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('접속 비밀번호').fill('saved-items-test');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(source.id);
      await page.getByLabel('TARGET 비교 소스').selectOption(target.id);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      for (const component of selected) await page.getByLabel(`${component.fullName} 배포 대상으로 선택`).check();
      await page.getByLabel('테스트 수준').selectOption('RunSpecifiedTests');
      await page.getByLabel('테스트 클래스 직접 입력').fill(tests.join(', '));
      let settings = page.locator('details[aria-label="저장한 배포 설정"]');
      await settings.locator('summary').click(); await settings.getByLabel('설정 이름').fill('선택 클래스와 테스트');
      await settings.getByRole('button', { name: '새 설정 저장', exact: true }).click();
      await expect(settings).toContainText('배포 대상 2개와 테스트 클래스 2개를 저장했습니다.');
      await page.reload();
      await expect(page.getByRole('button', { name: '메타데이터 비교', exact: true })).toBeEnabled();
      settings = page.locator('details[aria-label="저장한 배포 설정"]'); await settings.locator('summary').click();
      await settings.getByRole('combobox', { name: '저장 설정', exact: true }).selectOption({ label: '선택 클래스와 테스트' });
      const before = { sf: sfCalls, reads: reads.length, comparisons: comparisons.length, deployments: deployments.length };
      await settings.getByRole('button', { name: '불러오기', exact: true }).click();
      const saved = page.getByRole('region', { name: '저장한 배포 항목' });
      for (const component of selected) await expect(saved.getByLabel(`${component.fullName} 배포 대상으로 선택`)).toBeChecked();
      await expect(saved).not.toContainText('UnselectedClass');
      const apex = page.getByRole('region', { name: 'Apex 테스트 클래스 선택' });
      for (const name of tests) await expect(apex.getByRole('checkbox', { name, exact: true })).toBeChecked();
      await expect(page.getByLabel('테스트 클래스 직접 입력')).toHaveValue(tests.join(', '));
      await expect(settings).toContainText('배포 대상 2개와 테스트 클래스 2개를 불러왔습니다.');
      expect({ sf: sfCalls, reads: reads.length, comparisons: comparisons.length, deployments: deployments.length }).toEqual(before);
      const searchBox = await page.getByRole('region', { name: '메타데이터 검색', exact: true }).boundingBox();
      const savedBox = await saved.boundingBox(); const testsBox = await page.getByRole('region', { name: 'Apex 테스트 설정' }).boundingBox();
      expect(savedBox!.y).toBeGreaterThanOrEqual(searchBox!.y + searchBox!.height);
      expect(savedBox!.y + savedBox!.height).toBeLessThanOrEqual(testsBox!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
      await page.screenshot({ path: test.info().outputPath(`saved-items-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '배포 대상 실제 배포', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '실제 배포 내용 확인' });
      await dialog.getByRole('checkbox', { name: '위 소스·대상·반영 범위를 확인했습니다.' }).check();
      await dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' }).click();
      await expect(page.getByRole('heading', { name: 'Salesforce 실제 배포 성공', exact: true })).toBeVisible();
      expect(deployments).toHaveLength(1);
      expect(deployments[0]).toMatchObject({ scope: 'selected', sourceId: source.id, targetOrgId: target.id, components: selected, testLevel: 'RunSpecifiedTests', tests });
      expect(comparisons).toHaveLength(before.comparisons);
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      await expect.poll(() => comparisons.length).toBe(before.comparisons + 1);
      expect(comparisons.at(-1)).toMatchObject({ scope: 'selected', components: selected, leftSourceId: target.id, rightSourceId: source.id });
      expect(comparisons.at(-1)).not.toHaveProperty('metadataType');
      expect(errors).toEqual([]);
    } finally { await page.context().close(); await app.close(); }
  });
}
