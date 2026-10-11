import { expect, test } from '@playwright/test';
import { createWebServer } from '../src/web/server/app.js';
import type { WorkspaceSource } from '../src/api/workspace-contracts.js';

for (const width of [1440, 390]) {
  for (const operation of ['compare', 'dry-run', 'direct'] as const) {
    test(`저장한 Git ref 이동 시 ${operation} 제출을 중단하고 새 커밋 확인을 요구한다 (${width}px)`, async ({ page }) => {
      const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true,
        accessPassword: 'preset-review-test', databasePath: ':memory:',
        sfClient: { async runJson() { return { result: { nonScratchOrgs: [{ alias: 'target', username: 'target@example.com',
          orgId: '00D000000000001', connectedStatus: 'Connected', isSandbox: true }] } }; } },
      });
      const target: WorkspaceSource = { id: 'org:target', kind: 'org', label: 'target', environment: 'sandbox' };
      const source: WorkspaceSource = { id: 'git-registered:saved-branch', kind: 'local', location: 'git', label: 'owner/project · main' };
      const sha = 'b'.repeat(40);
      const preparedSource: WorkspaceSource = { ...source, id: 'git:prepared-import', provenance: {
        provider: 'github', host: 'github.com', repositoryId: '123', repositoryPath: 'owner/project',
        refType: 'branch', refName: 'main', commitSha: sha, projectRoot: '.', metadataType: 'ApexClass',
        importedAt: '2026-10-11T00:00:00Z', importedContentChecksum: 'c'.repeat(64), sourceOwnerUserId: 'test-owner', importId: 'prepared-import',
      } };
      const preset = { id: 'moving-ref-preset', name: '저장한 Git 배포', schemaVersion: 1,
        createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' };
      const components = [{ type: 'ApexClass', fullName: 'SavedClass' }];
      const selection = { sourceId: source.id, targetId: target.id, metadataType: 'ApexClass', compareCurrentType: true,
        showIdentical: true, excludedPackageIds: [], testLevel: 'NoTestRun', tests: [], components };
      const submitted: { path: string; body: Record<string, unknown> }[] = [];
      const errors: string[] = []; let prepares = 0;
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        await page.setViewportSize({ width, height: 900 });
        await page.route('**/api/v1/metadata-types**', (route) => route.fulfill({ json: { metadataTypes: [{ name: 'ApexClass', directoryName: 'classes' }] } }));
        await page.route('**/api/v1/apex-test-classes**', (route) => route.fulfill({ json: { testClasses: [] } }));
        await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
        await page.route('**/api/v1/deployment-drafts', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { drafts: [] }
          : { id: 'review-draft', tabId: route.request().postDataJSON().tabId, expiresAt: '2099-01-01T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' } }));
        await page.route('**/api/v1/deployment-presets', (route) => route.fulfill({ json: { presets: [preset] } }));
        await page.route('**/api/v1/deployment-presets/moving-ref-preset/resolve', (route) => route.fulfill({ json: {
          preset, selection, source, target, warnings: [], preparationRequired: true,
        } }));
        await page.route('**/api/v1/deployment-presets/moving-ref-preset/prepare', (route) => {
          prepares++;
          return route.fulfill({ json: { preset, selection: { ...selection, sourceId: preparedSource.id }, source: preparedSource, target,
            warnings: ['Git ref가 이동했습니다. 현재 커밋으로 다시 비교·검증하세요.'], preparationRequired: false } });
        });
        await page.route('**/api/v1/comparisons', (route) => {
          if (route.request().method() === 'GET') return route.fulfill({ json: { jobs: [] } });
          submitted.push({ path: 'compare', body: route.request().postDataJSON() });
          return route.fulfill({ json: { job: { id: 'review-comparison', status: 'SUCCEEDED', scope: 'manifest', manifest: '선택 항목',
            left: target, right: preparedSource, result: { summary: { total: 1, added: 0, removed: 0, modified: 1, identical: 0, different: 1 },
              warnings: [], components: components.map((component) => ({ ...component, key: 'ApexClass:SavedClass', status: 'MODIFIED', files: [] })) } } } });
        });
        await page.route('**/api/v1/deployments/*', (route) => {
          const path = route.request().url().split('/').at(-1)!;
          submitted.push({ path, body: route.request().postDataJSON() });
          return route.fulfill({ json: { job: { id: 'review-deployment', kind: path === 'dry-run' ? 'DRY_RUN' : 'DEPLOY',
            status: path === 'dry-run' ? 'APPROVAL_PENDING' : 'SUCCEEDED', source: preparedSource, target,
            manifest: '선택 항목', scope: 'selected', components, prepared: true, remoteStatus: 'SUCCEEDED',
            createdAt: '2026-10-11T00:00:00Z' } } });
        });
        await page.goto(`${address}/deploy`);
        await page.getByLabel('접속 비밀번호').fill('preset-review-test');
        await page.getByRole('button', { name: '접속', exact: true }).click();
        const settings = page.locator('details[aria-label="저장한 배포 설정"]');
        await settings.locator('summary').click();
        await settings.getByRole('combobox', { name: '저장 설정', exact: true }).selectOption(preset.id);
        await settings.getByRole('button', { name: '불러오기', exact: true }).click();
        await expect(page.getByLabel('SavedClass 배포 대상으로 선택')).toBeChecked();
        expect(prepares).toBe(0); expect(submitted).toHaveLength(0);
        const action = page.getByRole('button', { name: operation === 'compare' ? '메타데이터 비교'
          : operation === 'dry-run' ? '배포 대상 Dry-run' : '배포 대상 실제 배포', exact: true });
        const run = async (expectNewCommit = false) => {
          await action.click();
          if (operation === 'direct') {
            const dialog = page.getByRole('dialog', { name: '실제 배포 내용 확인' });
            if (expectNewCommit) await expect(dialog).toContainText(sha);
            await expect(dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' })).toBeDisabled();
            await dialog.getByRole('checkbox', { name: '위 소스·대상·반영 범위를 확인했습니다.' }).check();
            await dialog.getByRole('button', { name: '확인한 내용으로 실제 배포' }).click();
          }
        };
        await run();
        let review = page.getByRole('dialog', { name: '저장한 Git 소스 변경 확인' });
        await expect(review).toContainText('Git ref가 이동했습니다.'); await expect(review).toContainText(sha);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        expect(submitted).toHaveLength(0);
        await review.getByRole('button', { name: '취소', exact: true }).click();
        expect(submitted).toHaveLength(0);
        await run();
        review = page.getByRole('dialog', { name: '저장한 Git 소스 변경 확인' });
        await expect(review).toContainText(sha); expect(prepares).toBe(2);
        await review.getByRole('button', { name: '변경된 소스를 확인했습니다' }).click();
        expect(submitted).toHaveLength(0);
        await run(true);
        await expect.poll(() => submitted.length).toBe(1);
        expect(prepares).toBe(2);
        expect(submitted[0]).toMatchObject({ path: operation,
          body: operation === 'compare' ? { scope: 'selected', components, rightSourceId: preparedSource.id, leftSourceId: target.id }
            : { scope: 'selected', components, sourceId: preparedSource.id, targetOrgId: target.id } });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        expect(errors).toEqual([]);
      } finally { await page.context().close(); await app.close(); }
    });
  }
}
