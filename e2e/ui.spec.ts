import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const email = 'e2e-admin@example.com';
const password = 'e2e correct horse battery staple';
const operatorEmail = 'e2e-operator@example.com';
const operatorPassword = 'e2e operator initial password';

test('일회용 코드로 최초 관리자를 생성한다', async ({ page }) => {
  await page.goto('http://127.0.0.1:27546');
  await expect(page.getByRole('heading', { name: '최초 관리자를 설정합니다.' })).toBeVisible();
  await page.getByLabel('초기 설정 코드').fill('sfud-e2e-bootstrap-token');
  await page.getByLabel('표시 이름').fill('E2E 관리자');
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '관리자 생성' }).click();
  await expect(page.getByRole('heading', { name: '배포 대시보드' })).toBeVisible();
});

test('로그인 실패를 표시하고 올바른 계정으로 대시보드에 진입한다', async ({ page }) => {
  await page.goto('http://127.0.0.1:27546');
  await expect(page.getByRole('heading', { name: '다시 오셨군요.' })).toBeVisible();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill('incorrect password value');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('alert')).toContainText('올바르지 않습니다');

  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '배포 대시보드' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
});

test('대시보드 shell과 핵심 안전 안내를 렌더링한다', async ({ page }) => {
  await login(page);

  await expect(page.getByRole('heading', { name: '배포 대시보드' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /변경을 먼저 확인하고/u })).toBeVisible();
  await expect(page.getByRole('link', { name: /비교 및 배포 시작/u })).toBeVisible();
  await expect(page.getByText('삭제는 자동으로 실행되지 않습니다.')).toBeVisible();
  await expect(page.getByText('UI 27546')).toBeVisible();
});

test('390px 모바일 화면에서 body 수평 overflow가 없다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );

  expect(hasHorizontalOverflow).toBe(false);
  await expect(page.getByRole('link', { name: /비교 및 배포 시작/u })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();
  await expect(page.getByRole('link', { name: '실행 기록', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '설정', exact: true })).toBeVisible();
});

test('메뉴마다 독립 URL과 화면을 제공한다', async ({ page }) => {
  await login(page, '/compare');
  await expect(page.getByRole('heading', { name: '검색한 메타데이터를 배포 대상으로 선택합니다.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '비교 및 배포', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('link', { name: '실행 기록', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/u);
  await expect(page.getByRole('heading', { name: '비교와 배포 이력을 다시 확인하세요.' })).toBeVisible();

  await page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/u);
  await expect(page.getByRole('heading', { name: '연결과 프로젝트 소스를 관리합니다.' })).toBeVisible();
});

test('ADMIN이 사용자를 생성하고 역할과 활성 상태를 관리한다', async ({ page }) => {
  await login(page, '/admin');
  await expect(page.getByRole('link', { name: '사용자 관리', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '사용자와 배포 권한을 관리합니다.' })).toBeVisible();
  const createPanel = page.getByRole('region', { name: '사용자 생성' });
  await createPanel.getByLabel('표시 이름').fill('E2E 운영자');
  await createPanel.getByLabel('이메일').fill(operatorEmail);
  await createPanel.getByLabel('역할').selectOption('OPERATOR');
  await createPanel.getByLabel('초기 비밀번호').fill(operatorPassword);
  await createPanel.getByRole('button', { name: '사용자 생성' }).click();
  await expect(page.getByRole('status')).toContainText('E2E 운영자 계정을 생성했습니다.');

  const userRow = page.locator('.admin-user-row', { hasText: operatorEmail });
  await expect(userRow).toContainText('OPERATOR');
  await userRow.getByRole('combobox', { name: 'E2E 운영자 역할' }).selectOption('DEPLOYER');
  await expect(page.getByRole('status')).toContainText('사용자 설정을 변경했습니다.');
  await expect(userRow.getByRole('combobox', { name: 'E2E 운영자 역할' })).toHaveValue('DEPLOYER');
  await userRow.getByRole('button', { name: '비활성화' }).click();
  await expect(userRow).toContainText('비활성');
  await userRow.getByRole('button', { name: '활성화' }).click();
  await expect(userRow).toContainText('활성');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )).toBe(false);

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '다시 오셨군요.' })).toBeVisible();
  await page.getByLabel('이메일').fill(operatorEmail);
  await page.getByLabel('비밀번호').fill(operatorPassword);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: 'ADMIN 권한이 필요합니다.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '사용자 관리', exact: true })).toHaveCount(0);
});

test('설정에서 내 단말기의 DX 프로젝트를 임시 소스로 업로드한다', async ({ page }, testInfo) => {
  const projectPath = testInfo.outputPath('uploaded-project');
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: '.', default: true }],
    sourceApiVersion: '67.0',
  }));
  await page.route('**/api/v1/workspace', async (route) => route.fulfill({ json: {
    orgs: [], projects: [], uploads: [], sources: [],
  } }));
  await login(page, '/settings');
  await expect(page.getByRole('heading', { name: '내 단말기 프로젝트' })).toBeVisible();
  const uploadInput = page.getByRole('region', { name: '내 단말기 프로젝트' }).locator('.upload-button input[type="file"]');
  await expect(uploadInput).toBeEnabled();
  await uploadInput.setInputFiles(projectPath);

  await expect(page.getByRole('status')).toContainText('uploaded-project 업로드 완료');
  await expect(page.getByRole('region', { name: '내 단말기 프로젝트' }).getByText('uploaded-project', { exact: true })).toBeVisible();
  await expect(page.getByText('내 단말기에서 임시 업로드 · 마지막 사용 후 4시간', { exact: true }))
    .toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )).toBe(false);
  await expect(page.getByText('DX 프로젝트 업로드', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '비교 및 배포', exact: true }).click();
  await expect(page.locator('.upload-button input[type="file"]')).toHaveCount(0);
  await expect(page.getByText('새 프로젝트 소스가 필요한가요?')).toHaveCount(0);
});

test('실제 비교 API 흐름의 대기와 결과를 화면에 표시한다', async ({ page }) => {
  await page.route('**/api/v1/workspace', async (route) => route.fulfill({
    json: {
      orgs: [],
      projects: [{ id: 'project-1', displayName: 'fixture-project', manifests: ['manifest/package.xml'] }],
      sources: [
        { id: 'org:left', kind: 'org', label: 'left', detail: 'Left Org · Developer' },
        { id: 'org:right', kind: 'org', label: 'right', detail: 'Right Org · Sandbox' },
      ],
    },
  }));
  await page.route('**/api/v1/metadata-types**', async (route) => route.fulfill({ json: {
    metadataTypes: [
      { name: 'CustomObject', directoryName: 'objects' },
      { name: 'LightningComponentBundle', directoryName: 'lwc' },
      { name: 'ApexClass', directoryName: 'classes' },
    ],
  } }));
  let polls = 0;
  await page.route('**/api/v1/comparisons**', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({
        scope: 'all',
        metadataType: 'ApexClass',
        leftSourceId: 'org:left',
        rightSourceId: 'org:right',
      });
      expect(route.request().postDataJSON()).not.toHaveProperty('manifest');
      expect(route.request().postDataJSON()).not.toHaveProperty('projectId');
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.fulfill({ json: { job: comparisonFixture('QUEUED') }, status: 202 });
      return;
    }
    if (new URL(route.request().url()).pathname === '/api/v1/comparisons') {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    polls += 1;
    await route.fulfill({ json: { job: comparisonFixture(polls > 1 ? 'SUCCEEDED' : 'RUNNING') } });
  });

  await login(page, '/deploy');
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스')).toHaveValue('org:right');
  await expect(page.getByLabel('TARGET ORG 비교 소스')).toHaveValue('org:left');
  const scopeCombobox = page.getByRole('combobox', { name: 'Salesforce metadata type' });
  await expect(scopeCombobox).toHaveValue('ApexClass');
  await expect(page.locator('#salesforce-deploy-metadata-types option')).toHaveCount(3);
  await expect(page.getByText('전체 메타데이터', { exact: true })).toHaveCount(0);
  await expect(page.getByText('3개 metadata type 검색 가능 · source와 target의 합집합')).toBeVisible();
  const comparisonOptions = page.getByRole('region', { name: '메타데이터 검색' });
  const comparisonButton = comparisonOptions.getByRole('button', { name: /비교 실행$/u });
  const apexTestOptions = page.getByRole('region', { name: 'Apex 테스트 설정' });
  await expect(comparisonOptions.getByText('Strict 비교')).toHaveCount(0);
  await expect(comparisonOptions.getByText('동일 항목 표시')).toBeVisible();
  await expect(comparisonButton).toBeVisible();
  await expect(apexTestOptions.getByRole('button', { name: /비교 실행/u })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '배포 대상' }).getByRole('button', { name: /비교 실행/u })).toHaveCount(0);
  const desktopComparisonButtonBox = await comparisonButton.boundingBox();
  const desktopApexTestOptionsBox = await apexTestOptions.boundingBox();
  expect(desktopComparisonButtonBox).not.toBeNull();
  expect(desktopApexTestOptionsBox).not.toBeNull();
  expect(desktopComparisonButtonBox!.y + desktopComparisonButtonBox!.height).toBeLessThan(desktopApexTestOptionsBox!.y);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileComparisonButtonBox = await comparisonButton.boundingBox();
  const mobileApexTestOptionsBox = await apexTestOptions.boundingBox();
  expect(mobileComparisonButtonBox).not.toBeNull();
  expect(mobileApexTestOptionsBox).not.toBeNull();
  expect(mobileComparisonButtonBox!.y + mobileComparisonButtonBox!.height).toBeLessThan(mobileApexTestOptionsBox!.y);
  const workflowStatus = page.getByRole('region', { name: '실행 현황' });
  await expect(workflowStatus).toBeVisible();
  await expect(workflowStatus.getByText('실시간 연결')).toBeVisible();
  await comparisonOptions.getByRole('button', { name: /비교 실행$/u }).click();
  await expect(comparisonOptions.getByRole('button', { name: '비교 실행 중……' })).toBeVisible({ timeout: 300 });
  await expect(comparisonOptions.getByText('읽기 전용 비교')).toHaveCount(0);
  await expect(comparisonOptions.getByText('현재 metadata type과 옵션으로 source와 target을 비교합니다.')).toHaveCount(0);
  await expect(page.getByLabel('비교 현황')).toContainText(/대기열|진행 중/u);
  await expect(page.getByText('메타데이터 비교 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'right → left' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel('비교 현황')).toContainText('완료');
  await expect(page.getByText('Hello', { exact: true })).toBeVisible();
  await expect(page.locator('.component-status', { hasText: 'MODIFIED' })).toBeVisible();
});

test('선택 변경 후 이전 비교 polling 결과를 폐기한다', async ({ page }) => {
  await page.route('**/api/v1/workspace', async (route) => route.fulfill({ json: {
    projects: [{ id: 'project-1', displayName: 'fixture-project', manifests: [] }],
    sources: [
      { id: 'org:left', kind: 'org', label: 'left', detail: 'Left Org' },
      { id: 'org:right', kind: 'org', label: 'right', detail: 'Right Org' },
      { id: 'org:third', kind: 'org', label: 'third', detail: 'Third Org' },
    ],
  } }));
  await page.route('**/api/v1/metadata-types**', async (route) => route.fulfill({ json: {
    metadataTypes: [
      { name: 'CustomObject', directoryName: 'objects' },
      { name: 'ApexClass', directoryName: 'classes' },
    ],
  } }));
  let pollingStarted = false;
  await page.route('**/api/v1/comparisons**', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 202, json: { job: comparisonFixture('QUEUED') } });
      return;
    }
    if (new URL(route.request().url()).pathname === '/api/v1/comparisons') {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    pollingStarted = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ json: { job: comparisonFixture('SUCCEEDED') } }).catch(() => undefined);
  });

  await login(page, '/deploy');
  await page.getByRole('button', { name: /비교 실행/u }).click();
  await expect(page.getByText('비교 대기 중')).toBeVisible();
  await expect.poll(() => pollingStarted, { timeout: 3_000 }).toBe(true);
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption('org:third');
  await expect(page.getByRole('button', { name: /비교 실행/u })).toBeEnabled();
  await page.waitForTimeout(600);

  await expect(page.getByRole('heading', { name: 'right → left' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /같은 범위로 Dry-run/u })).toHaveCount(0);
});

test('Salesforce dry-run의 실행 상태와 검증 결과를 화면에 표시한다', async ({ page }) => {
  await page.route('**/api/v1/workspace', async (route) => route.fulfill({ json: {
    orgs: [{ id: 'org:target', alias: 'target', label: 'Target', connected: true }],
    projects: [{ id: 'project-1', displayName: 'fixture-project', manifests: ['manifest/package.xml'] }],
    sources: [
      { id: 'org:target', kind: 'org', label: 'target', detail: 'Target · Developer' },
      { id: 'project:project-1', kind: 'local', label: 'fixture-project', detail: 'Local DX project' },
    ],
  } }));
  await page.route('**/api/v1/metadata-types**', async (route) => route.fulfill({ json: {
    metadataTypes: [
      { name: 'ApexClass', directoryName: 'classes' },
      { name: 'CustomObject', directoryName: 'objects' },
    ],
  } }));
  await page.route('**/api/v1/apex-test-classes**', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('sourceId')).toBe('project:project-1');
    await route.fulfill({ json: {
      testClasses: ['Hello_Test', 'Order_Test', 'PaymentValidationSpec'],
    } });
  });
  let comparisonPolls = 0;
  await page.route('**/api/v1/comparisons**', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({
        scope: 'all', metadataType: 'ApexClass',
        leftSourceId: 'org:target', rightSourceId: 'project:project-1',
      });
      await route.fulfill({ status: 202, json: { job: deploymentComparisonFixture('QUEUED') } });
      return;
    }
    if (new URL(route.request().url()).pathname === '/api/v1/comparisons') {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    comparisonPolls += 1;
    await route.fulfill({ json: { job: deploymentComparisonFixture(comparisonPolls > 1 ? 'SUCCEEDED' : 'RUNNING') } });
  });
  let dryRunSubmissions = 0;
  await page.route('**/api/v1/deployments/dry-run', async (route) => {
    dryRunSubmissions += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      scope: 'selected',
      components: [{ type: 'ApexClass', fullName: 'NewClass' }],
      sourceId: 'project:project-1', targetOrgId: 'org:target',
      testLevel: 'RunSpecifiedTests', tests: ['Hello_Test'],
    });
    expect(route.request().postDataJSON()).not.toHaveProperty('manifest');
    await route.fulfill({ status: 202, json: { job: dryRunFixture(
      'QUEUED', dryRunSubmissions === 1 ? 'dry-run-1' : 'dry-run-failed',
    ) } });
  });
  await page.route('**/api/v1/deployments/execute', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      dryRunJobId: 'dry-run-1', targetAlias: 'target', confirmation: '실제 배포',
    });
    await route.fulfill({ status: 202, json: { job: deploymentFixture('QUEUED') } });
  });
  await page.route('**/api/v1/deployments/direct', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      scope: 'selected',
      components: [{ type: 'ApexClass', fullName: 'NewClass' }],
      sourceId: 'project:project-1', targetOrgId: 'org:target', tests: ['Hello_Test'],
      targetConfirmation: 'target', confirmation: '실제 배포',
    });
    await route.fulfill({ status: 202, json: { job: directDeploymentFixture('QUEUED') } });
  });
  let dryRunPolls = 0;
  let deploymentPolls = 0;
  let directDeploymentPolls = 0;
  await page.route('**/api/v1/deployment-jobs**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/deployment-jobs') {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith('/direct-deploy-1')) {
      directDeploymentPolls += 1;
      await route.fulfill({ json: { job: directDeploymentFixture(
        directDeploymentPolls > 1 ? 'SUCCEEDED' : 'DEPLOYING',
      ) } });
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith('/deploy-1')) {
      deploymentPolls += 1;
      await route.fulfill({ json: { job: deploymentFixture(deploymentPolls > 1 ? 'SUCCEEDED' : 'DEPLOYING') } });
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith('/dry-run-failed')) {
      await route.fulfill({ json: { job: failedDryRunFixture() } });
      return;
    }
    dryRunPolls += 1;
    await route.fulfill({ json: { job: dryRunFixture(dryRunPolls > 1 ? 'APPROVAL_PENDING' : 'DRY_RUN_RUNNING') } });
  });

  await login(page, '/deploy');
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스')).toHaveValue('project:project-1');
  await expect(page.getByLabel('TARGET ORG 비교 소스')).toHaveValue('org:target');
  const directTestInput = page.getByLabel('테스트 클래스 직접 입력');
  await directTestInput.fill('Hello_Test, pay');
  const directTestSuggestions = page.getByRole('listbox', { name: 'source 테스트 클래스 검색 결과' });
  const paymentSuggestion = directTestSuggestions.getByRole('option', { name: 'PaymentValidationSpec' });
  await expect(paymentSuggestion).toBeVisible();
  await expect(directTestSuggestions.getByRole('option', { name: 'Hello_Test' })).toHaveCount(0);
  await directTestInput.press('Tab');
  await expect(paymentSuggestion).toBeFocused();
  await paymentSuggestion.press('Enter');
  await expect(directTestInput).toHaveValue('Hello_Test, PaymentValidationSpec');
  await directTestInput.clear();
  await page.getByRole('button', { name: /비교 실행/u }).click();
  await expect(page.getByText('메타데이터 비교 중')).toBeVisible();
  await expect(page.getByText('fixture-project → target · ApexClass', { exact: true })).toBeVisible();
  await expect(page.getByText('NEW', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('heading', { name: 'fixture-project → target' })).toBeVisible();
  const searchPanelBox = await page.getByRole('region', { name: '메타데이터 검색' }).boundingBox();
  const searchResultBox = await page.locator('.comparison-result').first().boundingBox();
  const testPanelBox = await page.getByRole('region', { name: 'Apex 테스트 설정' }).boundingBox();
  expect(searchPanelBox).not.toBeNull();
  expect(searchResultBox).not.toBeNull();
  expect(testPanelBox).not.toBeNull();
  expect(searchResultBox!.y).toBeGreaterThan(searchPanelBox!.y + searchPanelBox!.height);
  expect(searchResultBox!.y + searchResultBox!.height).toBeLessThan(testPanelBox!.y);
  const metadataResults = page.locator('.component-results');
  await expect(metadataResults.locator('.component-result')).toHaveCount(20);
  const resultPagination = page.getByRole('navigation', { name: '메타데이터 검색 결과 페이지' });
  await expect(resultPagination).toContainText('1 / 3페이지 · 1-20 / 42개');
  await resultPagination.getByRole('button', { name: '다음 페이지' }).click();
  await expect(metadataResults.locator('.component-result')).toHaveCount(20);
  await expect(page.getByText('Paged19', { exact: true })).toBeVisible();
  await expect(page.getByText('NewClass', { exact: true })).toHaveCount(0);
  await resultPagination.getByRole('button', { name: '다음 페이지' }).click();
  await expect(metadataResults.locator('.component-result')).toHaveCount(2);
  await expect(resultPagination).toContainText('3 / 3페이지 · 41-42 / 42개');
  await resultPagination.getByRole('button', { name: '이전 페이지' }).click();
  await resultPagination.getByRole('button', { name: '이전 페이지' }).click();
  await page.getByLabel('NewClass 배포 대상으로 선택').check();
  await expect(page.getByLabel('OldClass 배포 대상으로 선택')).toBeDisabled();
  await expect(page.getByLabel('배포 대상').getByText('NewClass', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeVisible();
  await expect(page.getByRole('button', { name: '배포 대상 실제 배포' })).toBeVisible();
  await expect(page.getByRole('button', { name: '배포 대상 실제 배포' })).toBeDisabled();
  const apexTests = page.getByRole('region', { name: 'Apex 테스트 클래스 선택' });
  await expect(apexTests.getByRole('checkbox', { name: 'Hello_Test' })).toBeVisible();
  await page.getByLabel('테스트 클래스 검색').fill('validation');
  await expect(apexTests.getByRole('checkbox', { name: 'PaymentValidationSpec' })).toBeVisible();
  await expect(apexTests.getByRole('checkbox', { name: 'Hello_Test' })).toHaveCount(0);
  await expect(apexTests.getByText('1 / 3개 표시')).toBeVisible();
  await page.getByLabel('테스트 클래스 검색').fill('');
  await page.getByLabel('테스트 수준').selectOption('RunSpecifiedTests');
  await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeDisabled();
  await apexTests.getByRole('checkbox', { name: 'Hello_Test' }).check();
  await expect(page.getByLabel('테스트 클래스 직접 입력')).toHaveValue('Hello_Test');
  await expect(page.getByRole('button', { name: '배포 대상 Dry-run' })).toBeEnabled();
  await expect(page.getByText('코드 커버리지 75% 이상일 때만 배포합니다.')).toBeVisible();
  await page.getByLabel('대상 org 별칭').fill('target');
  await page.getByLabel('확인 문구').fill('실제 배포');
  await page.getByRole('button', { name: '배포 대상 실제 배포' }).click();
  await expect(page.getByText('Salesforce 실제 배포 중')).toBeVisible();
  await expect(page.getByLabel('실제 배포 현황')).toContainText(/InProgress · \d+초/u);
  await expect(page.getByLabel('실제 배포 현황')).toContainText('컴포넌트 1/2');
  await expect(page.getByRole('heading', { name: 'Salesforce 실제 배포 성공' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/Hello_Test · 코드 커버리지 80.00%/u)).toBeVisible();
  await page.getByRole('combobox', { name: 'Salesforce metadata type' }).fill('CustomObject');
  await expect(page.getByLabel('배포 대상').getByText('NewClass', { exact: true })).toBeVisible();
  await expect(apexTests.getByRole('checkbox', { name: 'Hello_Test' })).toBeChecked();
  await page.getByRole('button', { name: '배포 대상 Dry-run' }).click();
  const dryRunStatus = page.getByLabel('Dry-run 현황');
  await expect(dryRunStatus).toContainText(/대기열|진행 중/u);
  await expect(dryRunStatus).toContainText(/SSE (연결됨|재연결 중|연결 중)/u);
  const dryRunStatusBox = await dryRunStatus.boundingBox();
  const dryRunButtonBox = await page.getByRole('button', { name: /Dry-run 중/u }).boundingBox();
  expect(dryRunStatusBox).not.toBeNull();
  expect(dryRunButtonBox).not.toBeNull();
  expect(dryRunStatusBox!.y + dryRunStatusBox!.height).toBeLessThanOrEqual(dryRunButtonBox!.y);
  await expect(page.getByText('Salesforce check-only 실행 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salesforce dry-run 성공' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel('Dry-run 현황')).toContainText('Dry-run 성공 · 실제 배포 승인 대기');
  const result = page.getByLabel('Salesforce dry-run 성공');
  await expect(result.getByText('RunSpecifiedTests', { exact: true })).toBeVisible();
  await expect(result.getByText(/Hello_Test/u)).toBeVisible();
  await page.getByLabel('대상 org 별칭').fill('target');
  await page.getByLabel('확인 문구').fill('실제 배포');
  await page.getByRole('button', { name: '배포 대상 실제 배포' }).click();
  await expect(page.getByLabel('실제 배포 현황')).toContainText(/대기열|진행 중/u);
  await expect(page.getByText('Salesforce 실제 배포 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salesforce 실제 배포 성공' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByLabel('실제 배포 현황')).toContainText('완료');

  await page.setViewportSize({ width: 390, height: 844 });
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  const resultBox = await result.boundingBox();
  const summaryBox = await page.getByRole('complementary', { name: '배포 대상' }).boundingBox();

  expect(hasHorizontalOverflow).toBe(false);
  expect(resultBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox!.y).toBeGreaterThan(resultBox!.y + resultBox!.height);
  await expect(page.getByRole('button', { name: '배포 대상 실제 배포' })).toBeVisible();

  await page.getByRole('button', { name: '배포 대상 Dry-run' }).click();
  await expect(page.getByText('dry-run이 실패했습니다.')).toBeVisible({ timeout: 5_000 });
  const liveFailure = page.getByLabel('Dry-run 현황');
  await expect(liveFailure.getByText('실패 원인', { exact: true })).toBeVisible();
  await expect(liveFailure.getByText('CryptoUtil_Test.encryptsAndDecryptsWithConfiguredKey', { exact: true })).toBeVisible();
  await expect(liveFailure.getByText('System.QueryException: List has no rows for assignment to SObject', { exact: true })).toBeVisible();
  await expect(liveFailure.getByText(/8\.696%.*75%/u)).toBeVisible();
  const diagnostics = page.getByRole('region', { name: 'Salesforce 상세 결과' });
  await expect(diagnostics.getByText('CryptoUtil_Test.encryptsAndDecryptsWithConfiguredKey', { exact: true })).toBeVisible();
  await expect(diagnostics.getByText('System.QueryException: List has no rows for assignment to SObject', { exact: true })).toBeVisible();
  await expect(diagnostics.locator('pre')).toContainText('Class.CryptoUtil.<init>: line 22, column 1');
  await expect(diagnostics.getByText(/8\.696%.*75%/u)).toBeVisible();
});

test('제품 파비콘을 제공한다', async ({ page, request }) => {
  await page.goto('http://127.0.0.1:27546');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
  const response = await request.get('http://127.0.0.1:27546/favicon.svg');
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain('<svg');
});

test('로그아웃하면 보호된 콘솔을 다시 숨긴다', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: '다시 오셨군요.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '다시 오셨군요.' })).toBeVisible();
});

async function login(page: Page, path = '/') {
  await page.goto(`http://127.0.0.1:27546${path}`);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
}

function comparisonFixture(status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED'): ComparisonFixture {
  return {
    id: 'comparison-1',
    status,
    manifest: 'manifest/package.xml',
    left: { id: 'org:left', kind: 'org', label: 'left' },
    right: { id: 'org:right', kind: 'org', label: 'right' },
    ...(status !== 'SUCCEEDED' ? {} : {
      result: {
        summary: { added: 0, removed: 0, modified: 1, identical: 0, total: 1, different: 1 },
        warnings: [],
        components: [{
          key: 'ApexClass:Hello', type: 'ApexClass', fullName: 'Hello', status: 'MODIFIED',
          files: [{ path: 'classes/Hello.cls', status: 'MODIFIED', unifiedDiff: '- left\n+ right' }],
        }],
      },
    }),
  };
}

function deploymentComparisonFixture(status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED') {
  return {
    id: 'deployment-comparison-1', status, scope: 'all', metadataType: 'ApexClass', manifest: 'ApexClass',
    left: { id: 'org:target', kind: 'org', label: 'target' },
    right: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    ...(status !== 'SUCCEEDED' ? {} : { result: {
      summary: { added: 41, removed: 1, modified: 0, identical: 0, total: 42, different: 42 },
      warnings: ['TARGET ONLY는 destructive manifest 없이는 삭제되지 않습니다.'],
      components: [
        { key: 'ApexClass:NewClass', type: 'ApexClass', fullName: 'NewClass', status: 'ADDED', files: [] },
        { key: 'ApexClass:OldClass', type: 'ApexClass', fullName: 'OldClass', status: 'REMOVED', files: [] },
        ...Array.from({ length: 40 }, (_, index) => ({
          key: `ApexClass:Paged${String(index + 1).padStart(2, '0')}`,
          type: 'ApexClass', fullName: `Paged${String(index + 1).padStart(2, '0')}`,
          status: 'ADDED' as const, files: [],
        })),
      ],
    } }),
  };
}

interface ComparisonFixture {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED';
  manifest: string;
  left: { id: string; kind: 'org'; label: string };
  right: { id: string; kind: 'org'; label: string };
  result?: {
    summary: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
    warnings: string[];
    components: Array<{
      key: string; type: string; fullName: string; status: 'MODIFIED';
      files: Array<{ path: string; status: string; unifiedDiff: string }>;
    }>;
  };
}

function dryRunFixture(status: 'QUEUED' | 'DRY_RUN_RUNNING' | 'APPROVAL_PENDING', id = 'dry-run-1') {
  return {
    id, kind: 'DRY_RUN', status,
    source: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    target: { id: 'org:target', kind: 'org', label: 'target' },
    manifest: 'manifest/package.xml', prepared: status === 'APPROVAL_PENDING',
    createdAt: '2026-08-23T06:00:00.000Z',
    ...(status === 'DRY_RUN_RUNNING' ? {
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      progress: {
        phase: 'DRY_RUN', deploymentId: '0Af-check-only', status: 'InProgress', done: false,
        numberComponentsDeployed: 1, numberComponentsTotal: 2,
        numberTestsCompleted: 0, numberTestsTotal: 1, checkedAt: new Date().toISOString(),
      },
    } : {}),
    ...(status !== 'APPROVAL_PENDING' ? {} : {
      payloadChecksum: 'b'.repeat(64), salesforceDeploymentId: '0Af-check-only',
      testPlan: { level: 'RunSpecifiedTests', tests: ['Hello_Test'], selection: 'suffix' },
      comparisonSummary: { added: 1, removed: 0, modified: 1, identical: 0, total: 2, different: 2 },
    }),
  };
}

function failedDryRunFixture() {
  return {
    ...dryRunFixture('QUEUED', 'dry-run-failed'),
    status: 'FAILED',
    salesforceDeploymentId: '0AfWU00000b5KLl0AM',
    startedAt: new Date(Date.now() - 2_000).toISOString(),
    completedAt: new Date().toISOString(),
    errorMessage: 'Salesforce 배포 0AfWU00000b5KLl0AM가 Failed 상태로 종료되었습니다. CryptoUtil_Test.encryptsAndDecryptsWithConfiguredKey: System.QueryException: List has no rows for assignment to SObject',
    progress: {
      phase: 'DRY_RUN', deploymentId: '0AfWU00000b5KLl0AM', status: 'Failed', done: true, success: false,
      numberComponentsDeployed: 2, numberComponentsTotal: 2, numberComponentErrors: 0,
      numberTestsCompleted: 0, numberTestsTotal: 1, numberTestErrors: 1,
      checkedAt: new Date().toISOString(),
      diagnostics: {
        componentFailures: [],
        testFailures: [{
          name: 'CryptoUtil_Test', methodName: 'encryptsAndDecryptsWithConfiguredKey',
          message: 'System.QueryException: List has no rows for assignment to SObject',
          stackTrace: 'Class.CryptoUtil.<init>: line 22, column 1\nClass.CryptoUtil_Test.encryptsAndDecryptsWithConfiguredKey: line 5, column 1',
          time: 85,
        }],
        codeCoverageWarnings: [{
          name: 'CryptoUtil',
          message: 'Test coverage of selected Apex Class is 8.696%, at least 75% test coverage is required',
        }],
        flowCoverageWarnings: [],
        messages: [],
      },
    },
  };
}

function deploymentFixture(status: 'QUEUED' | 'DEPLOYING' | 'SUCCEEDED') {
  return {
    id: 'deploy-1', kind: 'DEPLOY', status,
    source: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    target: { id: 'org:target', kind: 'org', label: 'target' },
    manifest: 'selected.xml', scope: 'selected', prepared: false,
    createdAt: '2026-08-23T06:01:00.000Z',
    ...(status === 'DEPLOYING' ? {
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      progress: {
        phase: 'DEPLOY', deploymentId: '0Af-deploy', status: 'InProgress', done: false,
        numberComponentsDeployed: 1, numberComponentsTotal: 2,
        numberTestsCompleted: 0, numberTestsTotal: 1, checkedAt: new Date().toISOString(),
      },
    } : {}),
    ...(status !== 'SUCCEEDED' ? {} : { salesforceDeploymentId: '0Af-deploy' }),
  };
}

function directDeploymentFixture(status: 'QUEUED' | 'DEPLOYING' | 'SUCCEEDED') {
  return {
    ...deploymentFixture(status),
    id: 'direct-deploy-1',
    testPlan: { level: 'RunSpecifiedTests', tests: ['Hello_Test'], selection: 'explicit' },
    ...(status === 'SUCCEEDED' ? { testCoverage: 80 } : {}),
  };
}
