import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const email = 'e2e-admin@example.com';
const password = 'e2e correct horse battery staple';

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
  await expect(page.getByRole('heading', { name: '검색한 메타데이터를 장바구니에 담아 배포합니다.' })).toBeVisible();
  await expect(page.getByRole('link', { name: '비교 및 배포', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('link', { name: '실행 기록', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/u);
  await expect(page.getByRole('heading', { name: '비교와 배포 이력을 다시 확인하세요.' })).toBeVisible();

  await page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/u);
  await expect(page.getByRole('heading', { name: '연결과 서버 프로젝트를 확인합니다.' })).toBeVisible();
});

test('내 단말기의 DX 프로젝트를 임시 소스로 업로드한다', async ({ page }, testInfo) => {
  const projectPath = testInfo.outputPath('uploaded-project');
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'sfdx-project.json'), JSON.stringify({
    packageDirectories: [{ path: '.', default: true }],
    sourceApiVersion: '67.0',
  }));
  await page.route('**/api/v1/workspace', async (route) => route.fulfill({ json: {
    orgs: [], projects: [], uploads: [], sources: [],
  } }));
  await login(page, '/deploy');
  const uploadInput = page.locator('.upload-button input[type="file"]');
  await expect(uploadInput).toBeEnabled();
  await uploadInput.setInputFiles(projectPath);

  await expect(page.getByRole('status')).toContainText('uploaded-project 업로드 완료');
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스')).toHaveValue(/^upload:/u);
  await expect(page.getByText('내 단말기에서 임시 업로드 · 마지막 사용 후 4시간', { exact: true }))
    .toBeVisible();
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
      { name: 'ApexClass', directoryName: 'classes' },
      { name: 'CustomObject', directoryName: 'objects' },
      { name: 'LightningComponentBundle', directoryName: 'lwc' },
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
  await expect(scopeCombobox).toHaveValue('전체 메타데이터');
  await expect(page.locator('#salesforce-deploy-metadata-types option')).toHaveCount(4);
  await scopeCombobox.fill('ApexClass');
  await expect(page.getByText('3개 metadata type 검색 가능 · source와 target의 합집합')).toBeVisible();
  await page.getByRole('button', { name: /비교 실행$/u }).click();
  await expect(page.getByText('메타데이터 비교 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'left → right' })).toBeVisible({ timeout: 5_000 });
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
      { name: 'ApexClass', directoryName: 'classes' },
      { name: 'CustomObject', directoryName: 'objects' },
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

  await expect(page.getByRole('heading', { name: 'left → right' })).toHaveCount(0);
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
  let comparisonPolls = 0;
  await page.route('**/api/v1/comparisons**', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({
        scope: 'all', leftSourceId: 'org:target', rightSourceId: 'project:project-1',
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
  await page.route('**/api/v1/deployments/dry-run', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      scope: 'selected',
      components: [{ type: 'ApexClass', fullName: 'NewClass' }],
      sourceId: 'project:project-1', targetOrgId: 'org:target',
    });
    expect(route.request().postDataJSON()).not.toHaveProperty('manifest');
    await route.fulfill({ status: 202, json: { job: dryRunFixture('QUEUED') } });
  });
  await page.route('**/api/v1/deployments/execute', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      dryRunJobId: 'dry-run-1', targetAlias: 'target', confirmation: '실제 배포',
    });
    await route.fulfill({ status: 202, json: { job: deploymentFixture('QUEUED') } });
  });
  let dryRunPolls = 0;
  let deploymentPolls = 0;
  await page.route('**/api/v1/deployment-jobs**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/v1/deployment-jobs') {
      await route.fulfill({ json: { jobs: [] } });
      return;
    }
    if (new URL(route.request().url()).pathname.endsWith('/deploy-1')) {
      deploymentPolls += 1;
      await route.fulfill({ json: { job: deploymentFixture(deploymentPolls > 1 ? 'SUCCEEDED' : 'DEPLOYING') } });
      return;
    }
    dryRunPolls += 1;
    await route.fulfill({ json: { job: dryRunFixture(dryRunPolls > 1 ? 'APPROVAL_PENDING' : 'DRY_RUN_RUNNING') } });
  });

  await login(page, '/deploy');
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스')).toHaveValue('project:project-1');
  await expect(page.getByLabel('TARGET ORG 비교 소스')).toHaveValue('org:target');
  await page.getByRole('button', { name: /비교 실행/u }).click();
  await expect(page.getByText('메타데이터 비교 중')).toBeVisible();
  await expect(page.getByText('NEW', { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  await page.getByLabel('NewClass 배포 장바구니').check();
  await expect(page.getByLabel('OldClass 배포 장바구니')).toBeDisabled();
  await expect(page.getByLabel('배포 장바구니').getByText('NewClass', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Salesforce metadata type' }).fill('CustomObject');
  await expect(page.getByLabel('배포 장바구니').getByText('NewClass', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '장바구니 Dry-run' }).click();
  await expect(page.getByText('Salesforce check-only 실행 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salesforce dry-run 성공' })).toBeVisible({ timeout: 5_000 });
  const result = page.getByLabel('Salesforce dry-run 성공');
  await expect(result.getByText('RunSpecifiedTests', { exact: true })).toBeVisible();
  await expect(result.getByText(/Hello_Test/u)).toBeVisible();
  await page.getByLabel('대상 org 별칭').fill('target');
  await page.getByLabel('확인 문구').fill('실제 배포');
  await page.getByRole('button', { name: '장바구니 실제 배포' }).click();
  await expect(page.getByText('Salesforce 실제 배포 중')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salesforce 실제 배포 성공' })).toBeVisible({ timeout: 5_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  const resultBox = await result.boundingBox();
  const summaryBox = await page.getByRole('complementary', { name: '배포 장바구니' }).boundingBox();

  expect(hasHorizontalOverflow).toBe(false);
  expect(resultBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(summaryBox!.y).toBeGreaterThan(resultBox!.y + resultBox!.height);
  await expect(page.getByRole('button', { name: '장바구니 실제 배포' })).toBeVisible();
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
    id: 'deployment-comparison-1', status, scope: 'all', manifest: '전체 메타데이터',
    left: { id: 'org:target', kind: 'org', label: 'target' },
    right: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    ...(status !== 'SUCCEEDED' ? {} : { result: {
      summary: { added: 1, removed: 1, modified: 0, identical: 0, total: 2, different: 2 },
      warnings: ['TARGET ONLY는 destructive manifest 없이는 삭제되지 않습니다.'],
      components: [
        { key: 'ApexClass:NewClass', type: 'ApexClass', fullName: 'NewClass', status: 'ADDED', files: [] },
        { key: 'ApexClass:OldClass', type: 'ApexClass', fullName: 'OldClass', status: 'REMOVED', files: [] },
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

function dryRunFixture(status: 'QUEUED' | 'DRY_RUN_RUNNING' | 'APPROVAL_PENDING') {
  return {
    id: 'dry-run-1', kind: 'DRY_RUN', status,
    source: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    target: { id: 'org:target', kind: 'org', label: 'target' },
    manifest: 'manifest/package.xml', prepared: status === 'APPROVAL_PENDING',
    createdAt: '2026-08-23T06:00:00.000Z',
    ...(status !== 'APPROVAL_PENDING' ? {} : {
      payloadChecksum: 'b'.repeat(64), salesforceDeploymentId: '0Af-check-only',
      testPlan: { level: 'RunSpecifiedTests', tests: ['Hello_Test'], selection: 'suffix' },
      comparisonSummary: { added: 1, removed: 0, modified: 1, identical: 0, total: 2, different: 2 },
    }),
  };
}

function deploymentFixture(status: 'QUEUED' | 'DEPLOYING' | 'SUCCEEDED') {
  return {
    id: 'deploy-1', kind: 'DEPLOY', status,
    source: { id: 'project:project-1', kind: 'local', label: 'fixture-project' },
    target: { id: 'org:target', kind: 'org', label: 'target' },
    manifest: 'selected.xml', scope: 'selected', prepared: false,
    createdAt: '2026-08-23T06:01:00.000Z',
    ...(status !== 'SUCCEEDED' ? {} : { salesforceDeploymentId: '0Af-deploy' }),
  };
}
