import { expect, test } from '@playwright/test';

const user = { id: 'auth-ui-fixture', email: 'auth-ui@example.test', displayName: '인증 UI', role: 'ADMIN' };
const connections = { localMode: true, callbackPort: 1717, storageStatus: 'cli', connections: [] };
const remoteReadyConnections = { localMode: false, storageStatus: 'ready', oauth: { ready: true }, connections: [] };
const remoteMissingConnections = { localMode: false, storageStatus: 'not_configured',
  oauth: { ready: false, reason: 'not_configured' }, connections: [] };

test('Salesforce 인증 로딩 중 잘못된 폼을 숨기고 반응형 로그인 폼을 표시한다', async ({ page }, testInfo) => {
  let resolveConnections!: () => void;
  const waiting = new Promise<void>((resolve) => { resolveConnections = resolve; });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockAuthenticatedConsole(page);
  await page.route('**/api/v1/salesforce/connections', async (route) => {
    await waiting;
    await route.fulfill({ json: connections });
  });

  await page.goto('http://127.0.0.1:27546/auth');
  const salesforce = page.getByRole('region', { name: 'Salesforce 인증' });
  await expect(salesforce.getByRole('status')).toContainText('불러오는 중');
  await expect(salesforce.getByLabel('SFDX 인증 URL')).toHaveCount(0);
  await expect(salesforce.getByLabel('Salesforce 로그인 주소')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Git 계정 연결' })).toBeVisible();

  resolveConnections();
  await salesforce.getByRole('button', { name: '새 연결', exact: true }).click();
  await expect(salesforce.getByLabel('Salesforce 로그인 주소')).toHaveValue('https://login.salesforce.com');
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const localAccountMenu = page.locator('.account-menu-local');
    if (width <= 700) await expect(localAccountMenu).toBeHidden();
    else await expect(localAccountMenu).toBeVisible();
    const metrics = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.salesforce-fields input[type="url"]')!;
      const button = document.querySelector<HTMLButtonElement>('.salesforce-actions .button')!;
      const form = document.querySelector<HTMLElement>('.salesforce-form')!;
      const panel = document.querySelector<HTMLElement>('.connection-dialog')!;
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        urlFits: input.scrollWidth <= input.clientWidth + 2,
        buttonWidth: buttonRect.width,
        formWidth: formRect.width,
        buttonInPanel: buttonRect.left >= panelRect.left && buttonRect.right <= panelRect.right,
        fieldInForm: inputRect.left >= formRect.left && inputRect.right <= formRect.right,
      };
    });
    expect(metrics.overflow, `${width}px 페이지 가로 넘침`).toBe(false);
    expect(metrics.urlFits, `${width}px Salesforce 로그인 주소 입력 영역`).toBe(true);
    expect(metrics.buttonInPanel, `${width}px 로그인 버튼 패널 경계`).toBe(true);
    expect(metrics.fieldInForm, `${width}px 로그인 주소 폼 경계`).toBe(true);
    if (width > 700) expect(metrics.buttonWidth, `${width}px 버튼 너비`).toBeLessThan(metrics.formWidth * .8);
    if ([1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`auth-${width}.png`), fullPage: true });
  }
  expect(pageErrors).toEqual([]);
});

test('Salesforce 인증 초기 오류에서 재시도를 제공하고 성공 상태로 회복한다', async ({ page }) => {
  let attempts = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockAuthenticatedConsole(page);
  await page.route('**/api/v1/salesforce/connections', async (route) => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    return route.fulfill({ json: connections });
  });
  await page.goto('http://127.0.0.1:27546/auth');
  const salesforce = page.getByRole('region', { name: 'Salesforce 인증' });
  await expect(salesforce.getByRole('alert')).toBeVisible();
  await salesforce.getByRole('button', { name: '다시 시도' }).click();
  await salesforce.getByRole('button', { name: '새 연결', exact: true }).click();
  await expect(salesforce.getByLabel('Salesforce 로그인 주소')).toBeVisible();
  expect(attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test('원격 Salesforce OAuth 기본 화면을 PC·태블릿·모바일 폭에서 렌더링하고 수동 경로는 접어 둔다', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await mockAuthenticatedConsole(page, false);
  await page.route('**/api/v1/salesforce/connections', (route) => route.fulfill({ json: remoteReadyConnections }));
  await page.goto('http://127.0.0.1:27546/auth');
  await page.getByRole('region', { name: 'Salesforce 인증' }).getByRole('button', { name: '새 연결', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Salesforce 새 연결' });
  await expect(panel.getByRole('button', { name: 'Salesforce 계정 연결' })).toBeVisible();
  await expect(panel.getByText('수동 SFDX 인증 URL 등록')).toBeVisible();
  await expect(panel.getByLabel('SFDX 인증 URL')).toBeHidden();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.evaluate(() => {
      const visibleUrl = [...document.querySelectorAll<HTMLInputElement>('.salesforce-fields input[type="url"]')]
        .find((input) => input.getClientRects().length > 0)!;
      const button = [...document.querySelectorAll<HTMLButtonElement>('.salesforce-actions .button')]
        .find((item) => item.getClientRects().length > 0)!;
      const form = button.closest<HTMLElement>('.salesforce-form')!;
      const panelNode = document.querySelector<HTMLElement>('.connection-dialog')!;
      const urlRect = visibleUrl.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      const panelRect = panelNode.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        inputFits: visibleUrl.scrollWidth <= visibleUrl.clientWidth + 2,
        fieldInForm: urlRect.left >= formRect.left && urlRect.right <= formRect.right,
        buttonInPanel: buttonRect.left >= panelRect.left && buttonRect.right <= panelRect.right,
      };
    });
    expect(metrics.overflow, `${width}px 가로 넘침`).toBe(false);
    expect(metrics.inputFits, `${width}px 로그인 URL 입력`).toBe(true);
    expect(metrics.fieldInForm, `${width}px 필드 경계`).toBe(true);
    expect(metrics.buttonInPanel, `${width}px 연결 버튼 경계`).toBe(true);
    if ([1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath(`remote-oauth-ready-${width}.png`), fullPage: true });
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('OAuth 설정 미비 상태를 안내하고 수동 등록을 열 수 있다', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await mockAuthenticatedConsole(page, false);
  await page.route('**/api/v1/salesforce/connections', (route) => route.fulfill({ json: remoteMissingConnections }));
  await page.goto('http://127.0.0.1:27546/auth');
  await page.getByRole('region', { name: 'Salesforce 인증' }).getByRole('button', { name: '새 연결', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Salesforce 새 연결' });
  await expect(panel.getByText('Salesforce OAuth 앱과 공개 HTTPS 주소')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Salesforce 계정 연결' })).toHaveCount(0);
  await panel.getByText('수동 SFDX 인증 URL 등록').click();
  await expect(panel.getByLabel('SFDX 인증 URL')).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('연결 목록을 기본으로 표시하고 모달의 포커스·닫기·등록 완료를 처리한다', async ({ page }, testInfo) => {
  await mockAuthenticatedConsole(page, false);
  const saved = { id: 'modal-org', alias: 'modal-org', username: 'modal@example.test', status: 'CONNECTED' };
  let registered = false;
  let finishRegistration!: () => void;
  const pending = new Promise<void>((resolve) => { finishRegistration = resolve; });
  await page.route('**/api/v1/salesforce/connections', async (route) => {
    if (route.request().method() === 'POST') {
      await pending;
      registered = true;
      return route.fulfill({ status: 201, json: { connection: saved } });
    }
    return route.fulfill({ json: { ...remoteReadyConnections, connections: registered ? [saved] : [] } });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:27546/auth');
  const salesforce = page.getByRole('region', { name: 'Salesforce 인증' });
  const git = page.getByRole('region', { name: 'Git 계정 연결' });
  const sfOpen = salesforce.getByRole('button', { name: '새 연결', exact: true });
  const gitOpen = git.getByRole('button', { name: '새 연결', exact: true });
  await expect(salesforce.getByText('연결된 Salesforce Org가 없습니다.')).toBeVisible();
  await expect(git.getByText('연결된 Git 계정이 없습니다. 새 연결을 등록하세요.')).toBeVisible();
  await expect(page.getByLabel('SFDX 인증 URL')).toHaveCount(0);
  await expect(page.getByLabel('PAT / API Token')).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`connection-list-${width}.png`), fullPage: true });
    for (const [open, title] of [[sfOpen, 'Salesforce 새 연결'], [gitOpen, 'Git 새 연결']] as const) {
      await open.click();
      const dialog = page.getByRole('dialog', { name: title });
      await expect(dialog).toBeVisible();
      if (title.startsWith('Salesforce')) await dialog.getByText('수동 SFDX 인증 URL 등록', { exact: true }).click();
      const bounds = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { contained: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          overflow: element.scrollWidth > element.clientWidth + 1 };
      });
      expect(bounds).toEqual({ contained: true, overflow: false });
      await dialog.getByRole('button', { name: '닫기', exact: true }).focus();
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`connection-dialog-${title.startsWith('Salesforce') ? 'sf' : 'git'}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
    }
  }
  await sfOpen.click();
  const dialog = page.getByRole('dialog', { name: 'Salesforce 새 연결' });
  await dialog.getByText('수동 SFDX 인증 URL 등록', { exact: true }).click();
  await dialog.getByLabel('SFDX 인증 URL').fill('fixture-secret-not-a-real-auth-url');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await sfOpen.click();
  await dialog.getByText('수동 SFDX 인증 URL 등록', { exact: true }).click();
  await expect(dialog.getByLabel('SFDX 인증 URL')).toHaveValue('');
  await dialog.locator('.salesforce-manual-registration').getByLabel('연결 별칭').fill('modal-org');
  await dialog.getByLabel('SFDX 인증 URL').fill('fixture-secret-not-a-real-auth-url');
  await dialog.getByRole('button', { name: '연결 등록 또는 재인증' }).click();
  await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  finishRegistration();
  await expect(dialog).toHaveCount(0);
  await expect(salesforce.getByText('modal-org', { exact: true })).toBeVisible();
  await expect(salesforce.getByRole('status')).toContainText('연결을 등록했습니다.');
  expect(errors).toEqual([]);
});

test('Salesforce와 Git 연결을 같은 열과 상태 배지의 표로 표시한다', async ({ page }, testInfo) => {
  await mockAuthenticatedConsole(page, false);
  await page.route('**/api/v1/salesforce/connections', (route) => route.fulfill({ json: {
    ...remoteReadyConnections, connections: [
      { id: 'sf-prod', alias: '운영 Org', username: 'release.manager@example.test', orgId: '00D000000000001', status: 'CONNECTED' },
      { id: 'sf-test', alias: '개발 Org', username: 'developer@example.test', orgId: '00D000000000002', status: 'REAUTH_REQUIRED' },
    ],
  } }));
  const gitConnection = { provider: 'github', providerHost: 'github.com', providerAccountId: '123',
    displayName: 'release-manager', grantedPermissions: [], createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' };
  await page.route('**/api/v1/git/connections', (route) => route.fulfill({ json: { tokenStorage: 'ready', connections: [
    { ...gitConnection, id: 'git-prod', alias: '배포 저장소', repositoryPath: 'https://github.example.test:8443/projects/salesforce/metadata-release-project.git', status: 'ACTIVE' },
    { ...gitConnection, id: 'git-test', alias: '개발 계정', status: 'REAUTH_REQUIRED', expiresAt: '2026-09-01T00:00:00.000Z' },
  ] } }));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:27546/auth');
  const sfTable = page.getByRole('table', { name: 'Salesforce 연결 목록' });
  const gitTable = page.getByRole('table', { name: 'Git 연결 목록' });
  for (const table of [sfTable, gitTable]) {
    await expect(table.getByRole('columnheader')).toHaveText(['연결 이름', '대상', '상태', '관리']);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.locator('.connection-state-ready')).toHaveText('연결됨');
    await expect(table.locator('.connection-state-warning')).toHaveCount(1);
  }
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.evaluate(() => {
      const tables = [...document.querySelectorAll<HTMLTableElement>('.connection-table')];
      const columns = tables.map((table) => [...table.querySelectorAll('thead th')].map((cell) => cell.getBoundingClientRect().width));
      return { columnsMatch: columns[0]!.every((value, index) => Math.abs(value - columns[1]![index]!) < 1),
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        contained: [...document.querySelectorAll('.connection-table-scroll')].every((element) => {
          const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth;
        }) };
    });
    expect(metrics).toEqual({ columnsMatch: true, pageOverflow: false, contained: true });
    if (width < 720) {
      for (const table of [sfTable, gitTable]) {
        await table.locator('..').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        expect(await table.locator('..').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        await table.locator('..').evaluate((element) => { element.scrollLeft = 0; });
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`connection-tables-${width}.png`), fullPage: true });
  }
  expect(errors).toEqual([]);
});

async function mockAuthenticatedConsole(page: import('@playwright/test').Page, localMode = true) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json: Record<string, unknown> = {
      '/api/v1/auth/status': { setupRequired: false, authenticated: true, localMode, user },
      '/api/v1/health': { status: 'ok', service: 'sfud-ui', version: '0.4.0', host: '127.0.0.1', port: 27546 },
      '/api/v1/diagnostics': { status: 'ok', service: 'sfud-ui', version: '0.4.0', host: '127.0.0.1', port: 27546 },
      '/api/v1/workspace': { sources: [], projects: [], workingDirectory: '/fixture', warnings: [] },
      '/api/v1/comparisons': { jobs: [] },
      '/api/v1/deployment-jobs': { jobs: [] },
      '/api/v1/git/providers': { providers: [], tokenStorage: 'ready', environmentAvailable: false },
      '/api/v1/git/connections': { connections: [], tokenStorage: 'ready' },
    };
    if (path === '/api/v1/salesforce/connections') return route.continue();
    return route.fulfill({ json: json[path] ?? {} });
  });
}
