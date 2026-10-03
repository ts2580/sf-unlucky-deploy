import { expect, test } from '@playwright/test';
import { Value } from '@sinclair/typebox/value';
import { SaveDeploymentPresetSchema } from '../src/api/deployment-preset-contracts.js';
import { createWebServer } from '../src/web/server/app.js';

for (const width of [1440, 768, 390]) {
  test(`저장 설정 재접속·명시적 불러오기·늦은 응답 폐기 (${width}px)`, async ({ page }, testInfo) => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'preset-ui-fixture-password',
      databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: ['source', 'target'].map((alias, index) => ({
        alias, username: `${alias}@example.com`, orgId: `00D00000000000${index + 1}`, connectedStatus: 'Connected', isSandbox: true,
      })) } }; } } });
    const errors: string[] = []; const deploymentPosts: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { if (request.method() === 'POST' && /\/api\/v1\/deployments\//u.test(request.url())) deploymentPosts.push(request.url()); });
    const preset = { id: 'preset-fixture', name: '개발 서버 반영', schemaVersion: 1, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' };
    let saved: Record<string, unknown> | undefined; let slowResolve = false; let release: (() => void) | undefined;
    let resolveStarted = false;
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [
        { name: 'ApexClass', directoryName: 'classes' }, { name: 'CustomObject', directoryName: 'objects' }, { name: 'Flow', directoryName: 'flows' },
      ] } }));
      await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
      await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
      await page.route('**/api/v1/deployment-drafts', (route) => route.request().method() === 'GET'
        ? route.fulfill({ json: { drafts: [] } })
        : route.fulfill({ json: { id: 'draft-fixture', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' } }));
      await page.route('**/api/v1/deployment-presets', (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { presets: saved === undefined ? [] : [preset] } });
        const body = route.request().postDataJSON(); expect(Value.Check(SaveDeploymentPresetSchema, body)).toBe(true);
        saved = body.selection as Record<string, unknown>;
        expect(saved).not.toHaveProperty('components'); expect(saved).not.toHaveProperty('payloadChecksum');
        return route.fulfill({ status: 201, json: preset });
      });
      await page.route('**/api/v1/deployment-presets/preset-fixture/resolve', async (route) => {
        resolveStarted = true;
        if (slowResolve) await new Promise<void>((resolve) => { release = resolve; });
        await route.fulfill({ json: { preset, selection: saved, warnings: [], preparationRequired: false } });
      });
      await page.goto(`${address}/deploy`);
      await page.getByLabel('접속 비밀번호').fill('preset-ui-fixture-password');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:source');
      await page.getByLabel('TARGET 비교 소스').selectOption('org:target');
      await page.locator('#deploy-scope').fill('CustomObject');
      let settings = page.locator('details[aria-label="저장한 배포 설정"]');
      await settings.locator('summary').click();
      await settings.getByLabel('설정 이름').fill(preset.name);
      await settings.getByRole('button', { name: '새 설정 저장', exact: true }).click();
      await expect.poll(() => saved?.metadataType).toBe('CustomObject');
      await page.reload(); await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass');
      settings = page.locator('details[aria-label="저장한 배포 설정"]'); await settings.locator('summary').click();
      await settings.getByRole('combobox', { name: '저장 설정', exact: true }).selectOption(preset.id);
      await settings.getByRole('button', { name: '불러오기', exact: true }).click();
      await expect(page.locator('#deploy-scope')).toHaveValue('CustomObject');
      expect(deploymentPosts).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`presets-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      slowResolve = true; resolveStarted = false;
      await settings.getByRole('button', { name: '불러오기', exact: true }).click();
      await expect.poll(() => resolveStarted).toBe(true);
      await page.locator('#deploy-scope').fill('Flow'); release!();
      await expect(settings).toContainText('선택이 변경되어 이전 불러오기 결과를 적용하지 않았습니다.');
      await expect(page.locator('#deploy-scope')).toHaveValue('Flow');
      expect(deploymentPosts).toEqual([]); expect(errors).toEqual([]);
    } finally { release?.(); await page.goto('about:blank'); await app.close(); }
  });
}
