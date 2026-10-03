import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';

// A non-loopback hostname keeps Chromium in a real insecure context. Only DNS is
// mapped locally; do not override crypto or mark this origin as secure.
test.use({ launchOptions: { args: [
  '--host-resolver-rules=MAP sfud-remote.test 127.0.0.1', '--no-proxy-server',
] } });

for (const operation of ['dry-run', 'direct'] as const) {
  test(`원격 HTTP에서 ${operation} 요청의 UUID 생성과 재시도 키 보존`, async ({ page }) => {
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
      accessPassword: 'remote-http-test-password', databasePath: ':memory:',
      sfClient: { async runJson() { return { status: 0, result: { nonScratchOrgs: [] } }; } },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    const source = { id: 'project:fixture', kind: 'local', label: 'fixture-project' };
    const target = { id: 'org:target', kind: 'org', label: 'target' };
    const component = { type: 'CustomObject', fullName: 'Sample__c' };
    const keys: string[] = [];
    try {
      const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('127.0.0.1', 'sfud-remote.test');
      await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: {
        orgs: [{ ...target, alias: 'target', connected: true }],
        projects: [{ id: 'fixture', displayName: 'fixture-project', manifests: [] }],
        sources: [source, target],
      } }));
      await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: {
        metadataTypes: [{ name: 'CustomObject', directoryName: 'objects' }],
      } }));
      await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
      await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
      await page.route('**/api/v1/comparisons', (route) => route.fulfill({ json: route.request().method() === 'GET'
        ? { jobs: [] }
        : { job: { id: 'comparison-fixture', status: 'SUCCEEDED', scope: 'all', metadataType: 'CustomObject',
          manifest: 'CustomObject', left: target, right: source,
          result: { summary: { added: 1, removed: 0, modified: 0, identical: 0, total: 1, different: 1 },
            warnings: [], components: [{ ...component, key: 'CustomObject:Sample__c', status: 'ADDED', files: [] }] },
        } },
      }));
      // Stop at the browser/API boundary: never submit to a real Salesforce Org.
      await page.route(`**/api/v1/deployments/${operation}`, async (route) => {
        const request = route.request();
        expect(request.method()).toBe('POST');
        const key = request.headers()['idempotency-key']!;
        expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        expect(request.headers()['x-sfud-csrf']).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
        expect(request.postDataJSON()).toMatchObject({ scope: 'selected', components: [component],
          sourceId: source.id, targetOrgId: target.id });
        if (operation === 'direct') {
          expect(request.postDataJSON()).toMatchObject({ confirmation: '실제 배포', targetConfirmation: 'target' });
        }
        keys.push(key);
        // An unreadable successful response leaves the outcome uncertain. The
        // user's retry must send the original key, including on insecure HTTP.
        await route.fulfill({ status: 202, json: keys.length === 1 ? {} : { job: {
          id: `http-${operation}`, kind: operation === 'dry-run' ? 'DRY_RUN' : 'DEPLOY',
          status: operation === 'dry-run' ? 'APPROVAL_PENDING' : 'SUCCEEDED',
          source, target, manifest: 'selected.xml', prepared: true, remoteStatus: 'SUCCEEDED',
          payloadChecksum: 'a'.repeat(64), createdAt: new Date().toISOString(),
        } } });
      });
      await page.goto(`${address}/deploy`);
      expect(await page.evaluate(() => ({ secure: isSecureContext,
        randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues,
      }))).toEqual({ secure: false, randomUUID: 'undefined', getRandomValues: 'function' });
      await page.getByLabel('접속 비밀번호').fill('remote-http-test-password');
      await page.getByRole('button', { name: '접속', exact: true }).click();
      await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click();
      await page.getByLabel('Sample__c 배포 대상으로 선택').check();
      const button = page.getByRole('button', { name: operation === 'dry-run' ? '배포 대상 Dry-run' : '배포 대상 실제 배포', exact: true });
      await button.click();
      if (operation === 'direct') {
        const dialog = page.getByRole('dialog', { name: '실제 배포 내용 확인' });
        await expect(dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' })).toBeDisabled();
        await dialog.getByRole('checkbox', { name: '위 소스·대상·반영 범위를 확인했습니다.' }).check();
        await dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' }).click();
      }
      await expect(page.getByText('API 응답이 공유 계약과 일치하지 않습니다.', { exact: true })).toBeVisible();
      await button.click();
      if (operation === 'direct') {
        const dialog = page.getByRole('dialog', { name: '실제 배포 내용 확인' });
        await expect(dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' })).toBeDisabled();
        await dialog.getByRole('checkbox', { name: '위 소스·대상·반영 범위를 확인했습니다.' }).check();
        await dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' }).click();
      }
      await expect(page.getByRole('heading', { name: operation === 'dry-run' ? 'Salesforce dry-run 성공' : 'Salesforce 실제 배포 성공', exact: true })).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(errors).toEqual([]);
    } finally {
      await page.goto('about:blank');
      await app.close();
    }
  });
}
