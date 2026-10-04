import { expect, test, type Page } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';
const source = { id: 'project:fixture', kind: 'local', label: 'fixture-project' };
const target = { id: 'org:target', kind: 'org', label: 'target', username: 'target@example.com', maskedOrgId: '00D00…001', orgIdentityFingerprint: 'b'.repeat(64) };
const selection = { sourceId: source.id, targetId: target.id, metadataType: 'ApexClass', compareCurrentType: true, showIdentical: false, excludedPackageIds: [], testLevel: 'auto', tests: [] };
const component = { type: 'CustomObject', fullName: 'Sample__c' };
async function mockWorkspace(page: Page) {
  await page.route('**/api/v1/workspace', (route) => route.fulfill({ json: { orgs: [{ ...target, alias: 'target', connected: true }], projects: [{ id: 'fixture', displayName: 'fixture-project', manifests: [] }], sources: [source, target] } }));
  await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }, { name: 'CustomObject', directoryName: 'objects' }] } }));
  await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
  await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
  await page.route('**/api/v1/deployment-presets', (route) => route.fulfill({ json: { presets: [] } }));
  await page.route('**/api/v1/comparisons', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { jobs: [] } : { job: { id: 'comparison-fixture', status: 'SUCCEEDED', scope: 'all', metadataType: 'CustomObject', manifest: 'CustomObject', left: target, right: source, result: { summary: { added: 1, removed: 0, modified: 0, identical: 0, total: 1, different: 1 }, warnings: [], components: [{ ...component, key: 'CustomObject:Sample__c', status: 'ADDED', files: [] }] } } } }));
}
async function login(page: Page) { await page.getByLabel('접속 비밀번호').fill('recovery-test-password'); await page.getByRole('button', { name: '접속', exact: true }).click(); }
test('refresh preserves prior tab draft until explicit restore and never submits deployment', async ({ page }) => {
  const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'recovery-test-password', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
  const posts: string[] = []; const writes: unknown[] = [];
  let saved = { ...selection }; const tabId = '10000000-0000-4000-8000-000000000001';
  const draft = { id: 'draft-one', tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-04T01:00:00Z' };
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); await mockWorkspace(page);
    await page.route('**/api/v1/deployment-drafts', (route) => {
      if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); writes.push(body); saved = body.selection; return route.fulfill({ json: draft }); }
      return route.fulfill({ json: { drafts: [draft] } });
    });
    await page.route('**/api/v1/deployment-drafts/draft-one/resolve', (route) => route.fulfill({ json: { draft, resolved: { preset: { id: draft.id, name: '초안', schemaVersion: 1, createdAt: draft.updatedAt, updatedAt: draft.updatedAt }, selection: saved, warnings: [], preparationRequired: false } } }));
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/deployments/')) posts.push(request.url()); });
    await page.goto(`${address}/deploy`); await login(page);
    await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass');
    // A new untouched screen cannot replace the saved draft with defaults.
    await page.waitForTimeout(900); expect(writes).toHaveLength(0);
    await page.locator('#deploy-scope').fill('CustomObject'); await expect.poll(() => writes.length).toBe(1);
    expect(saved.metadataType).toBe('CustomObject');
    await page.reload(); await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass'); await page.waitForTimeout(900);
    expect(writes).toHaveLength(1); expect(saved.metadataType).toBe('CustomObject');
    await page.locator('details').filter({ has: page.getByText('탭별 선택 초안', { exact: true }) }).locator('summary').click();
    await page.getByRole('combobox', { name: '선택 초안', exact: true }).selectOption('draft-one'); await page.getByRole('button', { name: '선택 초안 복원', exact: true }).click();
    await expect(page.locator('#deploy-scope')).toHaveValue('CustomObject'); expect(posts).toEqual([]);
  } finally {
    // Close Chromium's connections before waiting for the fixture HTTP server.
    await test.step('브라우저 연결 종료', () => page.context().close());
    await test.step('테스트 서버 종료', () => app.close());
  }
});
test('unknown submission survives refresh and read-only lookup restores the original job', async ({ page }) => {
  const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'recovery-test-password', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
  const keys: string[] = []; let originalKey = '';
  const job = { id: 'resumed-job', kind: 'DRY_RUN', status: 'APPROVAL_PENDING', source, target, manifest: 'selected.xml', prepared: true, remoteStatus: 'SUCCEEDED', payloadChecksum: 'a'.repeat(64), createdAt: '2026-10-04T01:00:00Z' };
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); await mockWorkspace(page);
    await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ status: route.request().method() === 'PUT' ? 400 : 200, json: route.request().method() === 'PUT' ? { error: { message: 'fixture' } } : { drafts: [] } }));
    await page.route('**/api/v1/deployments/dry-run', (route) => { originalKey = route.request().headers()['idempotency-key']!; keys.push(originalKey); return route.fulfill({ status: 202, json: {} }); });
    await page.route('**/api/v1/deployment-submissions/dry-run/*', (route) => { expect(route.request().method()).toBe('GET'); expect(route.request().url()).toContain(originalKey); return route.fulfill({ json: { state: 'FOUND', job } }); });
    await page.route('**/api/v1/deployment-jobs/resumed-job', (route) => route.fulfill({ json: { job } }));
    await page.route('**/api/v1/deployment-jobs/resumed-job/new-selection', (route) => { expect(route.request().method()).toBe('GET'); return route.fulfill({ json: { preset: { id: job.id, name: '원래 작업 설정', schemaVersion: 1, createdAt: job.createdAt, updatedAt: job.createdAt }, selection: { ...selection, metadataType: 'CustomObject', testLevel: 'RunLocalTests' }, source, target, warnings: [], preparationRequired: false } }); });
    await page.goto(`${address}/deploy`); await login(page); await page.locator('#deploy-scope').fill('CustomObject');
    await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click(); await page.getByLabel('Sample__c 배포 대상으로 선택').check();
    await page.getByRole('button', { name: '배포 대상 Dry-run', exact: true }).click();
    await expect(page.getByText('API 응답이 공유 계약과 일치하지 않습니다.', { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('button', { name: '원래 요청 결과 조회' })).toBeVisible(); expect(keys).toHaveLength(1);
    await page.getByRole('button', { name: '원래 요청 결과 조회' }).click();
    await expect(page).toHaveURL(/job=resumed-job/u); await expect(page.getByRole('heading', { name: '작업 이어보기' })).toBeVisible(); expect(keys).toHaveLength(1);
    await page.reload(); await expect(page.getByRole('heading', { name: '작업 이어보기' })).toBeVisible(); expect(keys).toHaveLength(1);
    await page.getByRole('link', { name: '이 설정으로 새 작업', exact: true }).click();
    await expect(page).toHaveURL(/fromJob=resumed-job/u);
    await expect(page.locator('#deploy-scope')).toHaveValue('CustomObject');
    await expect(page.getByText('원래 작업 설정을 재검증했습니다. 현재 비교에서 컴포넌트를 다시 선택하세요.')).toBeVisible();
    await expect(page.getByText('선택된 배포 대상이 없습니다', { exact: true })).toBeVisible();
    expect(keys).toHaveLength(1);
  } finally {
    // Close Chromium's connections before waiting for the fixture HTTP server.
    await test.step('브라우저 연결 종료', () => page.context().close());
    await test.step('테스트 서버 종료', () => app.close());
  }
});
test('immediate refresh without BroadcastChannel keeps the owner fallback available for explicit revalidation', async ({ page }) => {
  const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'recovery-test-password', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
  let saved = { ...selection }; let tabId = ''; const writes: string[] = [];
  const makeDraft = () => ({ id: 'immediate-draft', tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-04T01:00:00Z' });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await page.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true }); });
    await mockWorkspace(page);
    await page.route('**/api/v1/deployment-drafts', (route) => {
      if (route.request().method() === 'PUT') { const body = route.request().postDataJSON(); tabId = body.tabId; saved = body.selection; writes.push(tabId); return route.fulfill({ json: makeDraft() }); }
      return route.fulfill({ json: { drafts: writes.length ? [makeDraft()] : [] } });
    });
    await page.route('**/api/v1/deployment-drafts/immediate-draft/resolve', (route) => route.fulfill({ json: { draft: makeDraft(), resolved: { preset: { id: 'immediate-draft', name: '선택 초안', schemaVersion: 1, createdAt: '', updatedAt: '' }, selection: saved, warnings: [], preparationRequired: false } } }));
    await page.goto(`${address}/deploy`); await login(page); await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass');
    await page.locator('#deploy-scope').fill('CustomObject');
    await page.reload(); await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass');
    expect(writes).toHaveLength(0);
    const details = page.locator('details').filter({ has: page.getByText('탭별 선택 초안', { exact: true }) }); await details.locator('summary').click();
    await page.getByRole('combobox', { name: '응답 전 선택 초안', exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: '응답 전 선택 복원', exact: true }).click();
    await expect(page.locator('#deploy-scope')).toHaveValue('CustomObject');
    expect(saved.metadataType).toBe('CustomObject'); expect(writes).toHaveLength(1);
  } finally {
    // Close Chromium's connections before waiting for the fixture HTTP server.
    await test.step('브라우저 연결 종료', () => page.context().close());
    await test.step('테스트 서버 종료', () => app.close());
  }
});
test('a rejected retry cannot erase an older ambiguous key', async ({ page }) => {
  const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, accessPassword: 'recovery-test-password', databasePath: ':memory:', sfClient: { async runJson() { return { result: { nonScratchOrgs: [] } }; } } });
  const keys: string[] = [];
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); await mockWorkspace(page);
    await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ status: route.request().method() === 'PUT' ? 400 : 200, json: route.request().method() === 'PUT' ? { error: { message: 'fixture' } } : { drafts: [] } }));
    await page.route('**/api/v1/deployments/dry-run', (route) => { keys.push(route.request().headers()['idempotency-key']!); return route.fulfill({ status: keys.length === 1 ? 202 : 403, json: keys.length === 1 ? {} : { error: { code: 'FORBIDDEN', message: 'fixture permission denial' } } }); });
    await page.route('**/api/v1/deployment-submissions/dry-run/*', (route) => route.fulfill({ json: { state: 'UNCONFIRMED' } }));
    await page.goto(`${address}/deploy`); await login(page); await page.locator('#deploy-scope').fill('CustomObject');
    await page.getByRole('button', { name: '메타데이터 비교', exact: true }).click(); await page.getByLabel('Sample__c 배포 대상으로 선택').check();
    await page.getByRole('button', { name: '배포 대상 Dry-run', exact: true }).click(); await expect(page.getByText('API 응답이 공유 계약과 일치하지 않습니다.', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole('checkbox', { name: '원래 입력과 동일한 제출 ID로 재시도합니다.' }).check();
    await page.getByRole('button', { name: '원래 요청 그대로 재시도', exact: true }).click();
    await expect(page.getByText('fixture permission denial')).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
    await page.reload(); await expect(page.getByRole('button', { name: '원래 요청 결과 조회' })).toBeVisible(); expect(keys).toHaveLength(2);
  } finally {
    // Close Chromium's connections before waiting for the fixture HTTP server.
    await test.step('브라우저 연결 종료', () => page.context().close());
    await test.step('테스트 서버 종료', () => app.close());
  }
});
