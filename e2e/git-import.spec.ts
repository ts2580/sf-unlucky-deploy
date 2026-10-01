import { expect, test, type Page, type Route } from '@playwright/test';
import type { GitConnection, GitConnectionListResponse, GitProvidersResponse } from '../src/api/git-contracts.js';
import type {
  GitCatalogPage, GitImport, GitImportListResponse, GitImportResponse, GitRefsResponse, GitRepositoryResponse,
} from '../src/api/git-project-contracts.js';
import type { WorkspaceResponse } from '../src/api/workspace-contracts.js';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/installed-packages**', (route) => route.fulfill({ json: { packages: [] } }));
});

const admin = { id: 'e2e-git-admin', email: 'git-ui@example.com', displayName: 'Git UI 관리자', role: 'ADMIN' as const };
const viewer = { id: 'e2e-git-viewer', email: 'git-viewer@example.com', displayName: 'Git UI 조회자', role: 'VIEWER' as const };
type E2EUser = typeof admin | typeof viewer;
const sha = '1'.repeat(40);
const commitSha = '2'.repeat(40);
const connectionId = '11111111-1111-4111-8111-111111111111';
const importId = '22222222-2222-4222-8222-222222222222';
const secondImportId = '33333333-3333-4333-8333-333333333333';
const historicalImportId = '44444444-4444-4444-8444-444444444444';
const releaseSha = '3'.repeat(40);
const targetSource: WorkspaceResponse['sources'][number] = {
  id: 'org:target', kind: 'org', location: 'org', label: 'target', detail: '연결된 org',
  username: 'target@example.com', maskedOrgId: '00D-target',
};

const providers: GitProvidersResponse = {
  environmentAvailable: true,
  providers: [
    { id: 'github', configured: true, publicImport: true, privateImport: true },
    { id: 'gitlab', configured: false, publicImport: true, privateImport: false },
    { id: 'bitbucket', configured: true, publicImport: true, privateImport: true },
  ],
  tokenStorage: 'ready',
};
const connections: GitConnectionListResponse = {
  connections: [{
    id: connectionId, provider: 'github', providerHost: 'github.com', providerAccountId: '42', displayName: 'GitHub private account',
    grantedPermissions: ['repo:read'], status: 'ACTIVE', createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
  }], tokenStorage: 'ready',
};
function connection(overrides: Partial<GitConnection> = {}): GitConnection {
  return { ...connections.connections[0]!, ...overrides };
}
const baseWorkspace: WorkspaceResponse = { orgs: [], projects: [], sources: [targetSource] };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function canonicalRepositoryPath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.replace(/^\//u, '').replace(/\.git$/u, '');
  } catch {
    return value.replace(/\.git$/u, '');
  }
}

async function browserStorage(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
}

function repository(privateRepository: boolean, provider: 'github' | 'gitlab' | 'bitbucket' = 'github'): GitRepositoryResponse {
  const host = provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org';
  return { repository: {
    provider, host, repositoryPath: 'owner/project', cloneUrl: `https://${host}/owner/project.git`,
    repositoryId: '123', defaultBranch: 'main', private: privateRepository,
  } };
}

function refs(kind: 'branch' | 'tag'): GitRefsResponse {
  return { refs: kind === 'branch'
    ? [{ kind: 'branch', name: 'main', commitSha: sha }, { kind: 'branch', name: 'release', commitSha: releaseSha }]
    : [{ kind: 'tag', name: 'v1.0.0', commitSha: sha }] };
}

function imported(status: GitImport['status'], overrides: Partial<GitImport> = {}): GitImport {
  return {
    id: importId, provider: 'github', repositoryPath: 'owner/project', ref: { kind: 'branch', name: 'main' }, expectedCommitSha: sha,
    metadataType: 'ApexClass',
    status, projectRoots: status === 'SELECTING' ? ['force-app', 'other'] : [], sizeBytes: 1024,
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', ...overrides,
  };
}

function readySource(sourceImportId = importId, overrides: Partial<NonNullable<GitImport['source']>> = {}): NonNullable<GitImport['source']> {
  const provenanceOverrides = overrides.provenance ?? {};
  return { id: `git:${sourceImportId}`, kind: 'local', location: 'git', label: 'owner/project', ...overrides, provenance: {
    provider: 'github', host: 'github.com', repositoryId: '123', repositoryPath: 'owner/project', refType: 'branch', refName: 'main',
    commitSha: sha, projectRoot: 'force-app', metadataType: 'ApexClass', importedAt: '2026-09-20T00:00:00.000Z', importedContentChecksum: 'a'.repeat(64),
    sourceOwnerUserId: admin.id, importId: sourceImportId, ...provenanceOverrides,
  } };
}

function comparisonFixture(overrides: {
  mode: 'compare' | 'source'; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED'; leftSourceId?: string; rightSourceId: string;
  components?: Array<Record<string, unknown>>;
}) {
  const components = overrides.components ?? [];
  const leftSourceId = overrides.leftSourceId ?? 'org:target';
  const leftLabel = leftSourceId.startsWith('git:') ? 'owner/project' : 'target';
  const rightLabel = overrides.rightSourceId.startsWith('org:') ? 'source' : 'owner/project';
  return {
    id: 'comparison-e2e', mode: overrides.mode, status: overrides.status, scope: 'all', metadataType: 'ApexClass', manifest: 'ApexClass',
    left: { id: leftSourceId, kind: leftSourceId.startsWith('org:') ? 'org' as const : 'local' as const, label: leftLabel },
    right: { id: overrides.rightSourceId, kind: overrides.rightSourceId.startsWith('org:') ? 'org' as const : 'local' as const, label: rightLabel },
    result: {
      summary: { added: components.filter((component) => component.status === 'ADDED').length,
        removed: components.filter((component) => component.status === 'REMOVED').length,
        modified: components.filter((component) => component.status === 'MODIFIED').length,
        identical: components.filter((component) => component.status === 'IDENTICAL').length,
        total: components.length, different: components.filter((component) => component.status !== 'IDENTICAL').length },
      warnings: [], components,
    },
  };
}

async function mockAuth(page: Page, user: E2EUser = admin) {
  await page.context().addCookies([{ name: 'sfud_csrf', value: 'e2e-csrf-token', url: 'http://127.0.0.1:27546' }]);
  await page.route('**/api/v1/auth/status', (route) => json(route, { setupRequired: false, authenticated: true, user }));
  await page.route('**/api/v1/health', (route) => json(route, { status: 'ok', service: 'sfud-ui', version: '0.3.0' }));
  await page.route('**/api/v1/diagnostics', (route) => json(route, {
    status: 'ok', service: 'sfud-ui', version: '0.3.0', host: '127.0.0.1', port: 27546,
    storage: { engine: 'sqlite', status: 'ok' }, queue: { queuedCount: 0 }, comparisonQueue: { queuedCount: 0 },
    recoveredJobCount: 0, recoveredComparisonCount: 0,
  }));
  await page.route('**/api/v1/git/registrations', (route) => json(route, { registrations: [] }));
  await page.route('**/api/v1/salesforce/connections', (route) => json(route, {
    localMode: false, storageStatus: 'ready', connections: [],
  }));
  await page.route('**/api/v1/settings', (route) => json(route, { settings: { testClassSuffix: '_Test' } }));
  // App loads these dashboard summaries immediately after authentication. Keep
  // the UI contract test isolated from the real queue state.
  await page.route('**/api/v1/comparisons', (route) => json(route, { jobs: [] }));
  await page.route('**/api/v1/deployment-jobs', (route) => json(route, { jobs: [] }));
}

async function mockGitApis(page: Page, options: {
  user?: E2EUser; initialImports?: GitImport[]; initialConnections?: GitConnectionListResponse['connections'];
  tokenStorage?: GitConnectionListResponse['tokenStorage']; environmentAvailable?: boolean; allProvidersConfigured?: boolean;
  extraSources?: WorkspaceResponse['sources']; comparisonComponents?: Array<Record<string, unknown>>;
} = {}) {
  await mockAuth(page, options.user ?? admin);
  await page.route('**/api/v1/admin/git-allowed-ips', (route) => json(route, { allowedIps: [] }));
  await page.route('**/api/v1/workflow/events', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream', body: ': connected\n\n',
  }));
  let items = [...(options.initialImports ?? [])];
  let workspace: WorkspaceResponse = {
    ...baseWorkspace,
    sources: [targetSource, ...(options.extraSources ?? []), ...items.flatMap((item) => item.source === undefined ? [] : [item.source])],
  };
  let inspectPrivate = false;
  let createError: { code: string; message: string } | undefined;
  let tokenError: { code: string; message: string } | undefined;
  const requestedKinds: string[] = [];
  const catalogRequests: string[] = [];
  let accounts = [...(options.initialConnections ?? connections.connections)];
  const tokenRequests: Array<Record<string, unknown>> = [];
  const refRequests: Array<Record<string, unknown>> = [];
  const importRequests: Array<Record<string, unknown>> = [];
  const metadataRequests: string[] = [];
  const comparisonRequests: Array<Record<string, unknown>> = [];
  const createdImportIds: string[] = [];
  const selectedImportIds: string[] = [];
  const csrfHeaders: string[] = [];
  let importDelayMs = 0;
  const importDelays: number[] = [];
  await page.route('**/api/v1/workspace', (route) => json(route, workspace));
  await page.route('**/api/v1/apex-test-classes**', (route) => json(route, { testClasses: [] }));
  await page.route('**/api/v1/metadata-types**', (route) => {
    metadataRequests.push(route.request().url());
    return json(route, { metadataTypes: [
      { name: 'ApexClass', directoryName: 'classes' },
      { name: 'CustomObject', directoryName: 'objects' },
      { name: 'CustomField', directoryName: 'objects', childDirectory: 'fields' },
    ] });
  });
  await page.route('**/api/v1/comparisons', async (route) => {
    if (route.request().method() === 'GET') return json(route, { jobs: [] });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    comparisonRequests.push(body);
    const rightSourceId = body.rightSourceId as string;
    return json(route, { job: comparisonFixture({ mode: body.sourceOnly === true ? 'source' : 'compare', status: 'SUCCEEDED',
      ...(typeof body.leftSourceId === 'string' ? { leftSourceId: body.leftSourceId } : {}), rightSourceId,
      ...(options.comparisonComponents === undefined ? {} : { components: options.comparisonComponents }) }) }, 202);
  });
  const providerResponse = {
    ...providers,
    ...(options.allProvidersConfigured ? { providers: providers.providers.map((entry) => ({ ...entry, configured: true, privateImport: true })) } : {}),
    tokenStorage: options.tokenStorage ?? providers.tokenStorage,
    environmentAvailable: options.environmentAvailable ?? true,
  };
  await page.route('**/api/v1/git/providers', (route) => json(route, providerResponse));
  await page.route('**/api/v1/git/connections', async (route) => {
    if (route.request().method() === 'GET') return json(route, { connections: accounts, tokenStorage: providerResponse.tokenStorage });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    csrfHeaders.push(route.request().headers()['x-sfud-csrf'] ?? '');
    tokenRequests.push(body);
    if (tokenError !== undefined) return json(route, { error: tokenError }, 400);
    const provider = body.provider as 'github' | 'gitlab' | 'bitbucket';
    const account = connection({ id: connectionId, provider,
      providerHost: provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org',
      displayName: provider === 'bitbucket' ? 'Bitbucket token account' : `${provider} token account`,
      ...(body.repositoryPath === undefined ? {} : { repositoryPath: canonicalRepositoryPath(body.repositoryPath as string) }),
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as string }),
    });
    accounts = [account];
    return json(route, { connection: account }, 201);
  });
  await page.route('**/api/v1/git/connections/environment', async (route) => {
    csrfHeaders.push(route.request().headers()['x-sfud-csrf'] ?? '');
    const account = connection({ displayName: 'github token account', status: 'ACTIVE' });
    accounts = [account];
    const result = [{ provider: 'github' as const, connection: account }];
    return json(route, { results: result });
  });
  await page.route('**/api/v1/git/connections/*', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/environment')) {
      const account = connection({ displayName: 'github token account', status: 'ACTIVE' });
      accounts = [account];
      return json(route, { results: [{ provider: 'github', connection: account }] });
    }
    const method = route.request().method();
    if (method === 'DELETE') { accounts = []; return route.fulfill({ status: 204 }); }
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (tokenError !== undefined) { tokenRequests.push(body); return json(route, { error: tokenError }, 400); }
      csrfHeaders.push(route.request().headers()['x-sfud-csrf'] ?? '');
      tokenRequests.push(body);
      const account = connection({ ...(accounts[0] ?? {}),
        ...(body.repositoryPath === undefined ? {} : { repositoryPath: canonicalRepositoryPath(body.repositoryPath as string) }),
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as string }),
      });
      accounts = [account];
      return json(route, { connection: account });
    }
    return json(route, { connections: accounts, tokenStorage: providerResponse.tokenStorage });
  });
  await page.route('**/api/v1/git/connections/*/repositories**', (route) => {
    catalogRequests.push(route.request().url());
    const url = new URL(route.request().url());
    const pageData: GitCatalogPage = url.searchParams.get('namespace') === null
      ? { namespaces: [], repositories: [{ repositoryId: 'repo-1', repositoryPath: 'owner/project' }] }
      : { namespaces: [], repositories: [{ repositoryId: 'repo-1', repositoryPath: 'owner/project' }] };
    return json(route, pageData);
  });
  await page.route('**/api/v1/git/repositories/inspect', async (route) => {
    const body = route.request().postDataJSON() as { connectionId?: string; provider: 'github' | 'gitlab' | 'bitbucket' };
    inspectPrivate = body.connectionId !== undefined;
    return json(route, repository(inspectPrivate, body.provider));
  });
  await page.route('**/api/v1/git/repositories/refs', async (route) => {
    const body = route.request().postDataJSON() as { kind: 'branch' | 'tag' };
    refRequests.push(body);
    requestedKinds.push(body.kind);
    return json(route, refs(body.kind));
  });
  await page.route('**/api/v1/git/imports', async (route) => {
    if (route.request().method() === 'GET') return json(route, { imports: items } satisfies GitImportListResponse);
    if (createError !== undefined) return json(route, { error: createError }, 400);
    const body = route.request().postDataJSON() as GitImport;
    importRequests.push(body);
    const delayMs = importDelays.length > 0 ? importDelays.shift()! : importDelayMs;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const id = importRequests.length === 1 ? importId : importRequests.length === 2 ? secondImportId : `55555555-5555-4555-8555-${String(importRequests.length).padStart(12, '0')}`;
    createdImportIds.push(id);
    const requestedHost = body.repositoryPath.includes('://') ? new URL(body.repositoryPath).hostname : undefined;
    const storedPath = requestedHost === undefined || ['github.com', 'gitlab.com', 'bitbucket.org'].includes(requestedHost)
      ? canonicalRepositoryPath(body.repositoryPath) : body.repositoryPath;
    const item = imported('SELECTING', { id, provider: body.provider, repositoryPath: storedPath, ref: body.ref, expectedCommitSha: body.expectedCommitSha,
      ...(body.metadataType === undefined ? {} : { metadataType: body.metadataType }),
      projectRoots: ['force-app', 'other'] });
    items = [...items, item];
    return json(route, { import: item } satisfies GitImportResponse, 202);
  });
  await page.route('**/api/v1/git/imports/*/select-project', async (route) => {
    const body = route.request().postDataJSON() as { projectRoot: string };
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? importId;
    selectedImportIds.push(id);
    const current = items.find((item) => item.id === id) ?? imported('SELECTING', { id });
    const source = readySource(id, { label: current.repositoryPath, provenance: {
      ...readySource(id).provenance!, repositoryPath: current.repositoryPath, refName: current.ref.name,
      commitSha: current.expectedCommitSha, projectRoot: body.projectRoot,
      ...(current.metadataType === undefined ? {} : { metadataType: current.metadataType }),
    } });
    const item = imported('READY', { ...current, status: 'READY', source });
    items = items.map((entry) => entry.id === id ? item : entry);
    workspace = { ...workspace, sources: [...workspace.sources.filter((entry) => entry.id !== source.id), source] };
    return json(route, { accepted: true });
  });
  await page.route('**/api/v1/git/imports/*/cancel', async (route) => {
    items = items.map((item) => ({ ...item, status: 'CANCELLED' })); return route.fulfill({ status: 204 });
  });
  await page.route('**/api/v1/git/imports/*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/select-project') && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { projectRoot: string };
      const id = pathname.split('/').at(-2) ?? importId;
      const current = items.find((item) => item.id === id) ?? imported('SELECTING', { id });
      const source = readySource(id, { label: current.repositoryPath, provenance: {
        ...readySource(id).provenance!, repositoryPath: current.repositoryPath, refName: current.ref.name,
        commitSha: current.expectedCommitSha, projectRoot: body.projectRoot,
        ...(current.metadataType === undefined ? {} : { metadataType: current.metadataType }),
      } });
      const item = imported('READY', { ...current, status: 'READY', source });
      items = items.map((entry) => entry.id === id ? item : entry);
      workspace = { ...workspace, sources: [...workspace.sources.filter((entry) => entry.id !== source.id), source] };
      return json(route, { accepted: true });
    }
    if (pathname.endsWith('/cancel') && route.request().method() === 'POST') {
      items = items.map((item) => ({ ...item, status: 'CANCELLED' }));
      return route.fulfill({ status: 204 });
    }
    if (route.request().method() === 'DELETE') {
      items = items.map((item) => ({ ...item, status: 'DELETED' })); return route.fulfill({ status: 204 });
    }
    const id = pathname.split('/').at(-1) ?? importId;
    return json(route, { import: items.find((item) => item.id === id) ?? imported('QUEUED', { id }) } satisfies GitImportResponse);
  });
  return {
    requestedKinds, catalogRequests, tokenRequests, refRequests, importRequests, createdImportIds, selectedImportIds, metadataRequests, comparisonRequests, csrfHeaders,
    setCreateError: (value: typeof createError) => { createError = value; },
    setTokenError: (value: typeof tokenError) => { tokenError = value; },
    setItems: (value: GitImport[]) => { items = value; },
    setImportDelay: (value: number) => { importDelayMs = value; },
    setImportDelays: (values: number[]) => { importDelays.splice(0, importDelays.length, ...values); },
  };
}

async function openSettings(page: Page, openImport = true) {
  await page.goto('http://127.0.0.1:27546/settings');
  await expect(page.getByRole('heading', { name: 'Git 프로젝트 가져오기' })).toBeVisible();
  if (openImport && await page.getByRole('dialog').count() === 0) {
    const open = page.getByRole('button', { name: '프로젝트 가져오기', exact: true });
    await expect(open).toBeEnabled({ timeout: 1000 }).catch(() => undefined);
    if (await open.isEnabled()) await open.click();
  }
  if (openImport && await page.getByRole('dialog').count() > 0) await expect(page.getByRole('dialog', { name: /Git 프로젝트 가져오기/u })).toBeVisible();
  await expect(page.getByRole('heading', { name: '내 Git 프로젝트' })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText('DX 프로젝트 업로드', { exact: true })).toHaveCount(0);
}

async function openConnections(page: Page) {
  await page.goto('http://127.0.0.1:27546/auth');
  await expect(page.getByRole('heading', { name: 'Git 계정 연결' })).toBeVisible();
}

async function openNewConnection(page: Page) {
  if (!await page.getByRole('dialog').isVisible()) {
    await page.getByRole('region', { name: 'Git 계정 연결' }).getByRole('button', { name: '새 연결', exact: true }).click();
  }
}

test('Git 프로젝트 모달은 취소 초안을 폐기하고 요청 오류가 나면 계속 열린다', async ({ page }) => {
  await mockGitApis(page);
  await openSettings(page);
  let failInspect = false;
  await page.route('**/api/v1/git/repositories/inspect', async (route) => {
    if (failInspect) return json(route, { error: { code: 'GIT_PROCESS_FAILED', message: '저장소 확인 실패' } }, 400);
    return route.fallback();
  });
  const dialog = page.getByRole('dialog', { name: 'Git 프로젝트 가져오기' });
  const url = page.getByLabel('저장소 URL 또는 경로');
  await url.fill('owner/cancelled');
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '프로젝트 가져오기', exact: true })).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('sfud:git-draft:e2e-git-admin'))).toBeNull();
  await page.getByRole('button', { name: '프로젝트 가져오기', exact: true }).click();
  await expect(page.getByLabel('저장소 URL 또는 경로')).toHaveValue('');
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/project');
  failInspect = true;
  await page.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('저장소 확인 실패');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Git 프로젝트(?: 다시)? 가져오기$/u }).getByLabel('저장소 URL 또는 경로')).toHaveValue('owner/project');
});

test('세 제공자 설정과 VIEWER token 작업 제한을 표시한다', async ({ page }) => {
  await mockGitApis(page);
  await openConnections(page);
  await openNewConnection(page);
  const providerSelect = page.getByLabel('토큰 제공자');
  await expect(providerSelect).toBeVisible();
  await expect(providerSelect.locator('option')).toHaveText(['GitHub', 'GitLab', 'Bitbucket']);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('account');
  await expect(page.getByRole('button', { name: '토큰 검증 후 등록' })).toBeDisabled();
  await page.getByLabel('PAT / API Token').fill('e2e-placeholder-token');
  await expect(page.getByRole('button', { name: '토큰 검증 후 등록' })).toBeEnabled();

  await page.unroute('**/api/v1/auth/status');
  await mockAuth(page, viewer);
  await page.reload();
  await expect(page.getByText('VIEWER 역할은 토큰을 등록하거나 변경할 수 없습니다.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByRole('button', { name: '새 연결', exact: true })).toBeDisabled();
  await openSettings(page);
  await expect(page.getByRole('button', { name: '프로젝트 가져오기', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const [provider, url] of [
  ['github', 'https://github.example.test:8443/context/team/project.git'],
  ['gitlab', 'https://gitlab.example.test:9443/gitlab/team/sub/project.git'],
  ['bitbucket', 'https://bitbucket.example.test:7990/bitbucket/scm/TEAM/project.git'],
] as const) test(`${provider} 셀프호스트 도메인·포트·경로를 refs·import·브랜치 등록·다시 가져오기에 보존한다`, async ({ page }) => {
  const saved = connection({ provider, providerHost: new URL(url).hostname, repositoryPath: url });
  const fixture = await mockGitApis(page, { allProvidersConfigured: true, initialConnections: [saved] });
  await page.route('**/api/v1/git/repositories/inspect', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ provider, repositoryPath: url, connectionId });
    return json(route, { repository: { provider, host: saved.providerHost, repositoryPath: canonicalRepositoryPath(url), cloneUrl: url,
      repositoryId: 'selfhost-repo', private: true, defaultBranch: 'main' } });
  });
  const registrations: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/git/registrations', (route) => {
    if (route.request().method() === 'POST') { registrations.push(route.request().postDataJSON()); return json(route, { registration: {} }, 201); }
    return json(route, { registrations: [] });
  });
  await openSettings(page);
  const panel = page.getByRole('dialog', { name: /^Git 프로젝트(?: 다시)? 가져오기$/u });
  await panel.getByRole('combobox', { name: 'Git 제공자', exact: true }).selectOption(provider);
  await panel.getByRole('combobox', { name: '접근 계정', exact: true }).selectOption(connectionId);
  await expect(panel.getByLabel('저장소 URL 또는 경로')).toHaveValue(url);
  await panel.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await expect(panel.getByLabel('브랜치 선택')).toHaveValue('main');
  expect(fixture.refRequests.at(-1)).toMatchObject({ provider, repositoryPath: url, connectionId });
  await panel.getByRole('button', { name: '배포 브랜치 등록', exact: true }).click();
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0]).toMatchObject({ provider, repositoryPath: url, connectionId });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '프로젝트 가져오기', exact: true }).click();
  await panel.getByLabel('Git 제공자').selectOption(provider);
  await panel.getByLabel('접근 계정').selectOption(connectionId);
  await expect(panel.getByLabel('저장소 URL 또는 경로')).toHaveValue(url);
  await panel.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await expect(panel.getByLabel('브랜치 선택')).toHaveValue('main');
  await panel.getByRole('button', { name: '이 커밋 가져오기', exact: true }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({ provider, repositoryPath: url, connectionId });
  fixture.setItems([imported('EXPIRED', { provider, repositoryPath: url })]);
  await page.reload();
  await page.getByRole('button', { name: '다시 가져오기', exact: true }).click();
  await expect(panel.getByLabel('저장소 URL 또는 경로')).toHaveValue(url);
  await panel.getByLabel('접근 계정').selectOption(connectionId);
  await panel.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await expect(panel.getByLabel('브랜치 선택')).toHaveValue('main');
  await panel.getByRole('button', { name: '이 커밋 가져오기', exact: true }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(2);
});

test('호스트를 복구하지 못한 과거 기록은 전체 URL을 다시 입력하도록 한다', async ({ page }) => {
  await mockGitApis(page, { initialImports: [imported('FAILED', { errorCode: 'GIT_REPOSITORY_URL_REQUIRED', errorMessage: '전체 HTTPS 저장소 URL로 다시 등록하세요.' })] });
  await openSettings(page, false);
  await page.getByRole('button', { name: '다시 가져오기', exact: true }).click();
  await expect(page.getByLabel('저장소 URL 또는 경로')).toHaveValue('');
  await expect(page.getByRole('button', { name: '저장소 확인', exact: true })).toBeDisabled();
});

test('저장한 Git 연결과 등록 브랜치에 별칭을 저장하고 선택 목록에 표시한다', async ({ page }) => {
  await mockGitApis(page);
  const fullUrl = 'https://git.example.com/group/long-project-name.git';
  let saved = connection({ repositoryPath: fullUrl, displayName: 'group/long-project-name' });
  const registration = { id: '55555555-5555-4555-8555-555555555555', alias: undefined as string | undefined,
    repositoryId: 'repo-1', request: { provider: 'github', repositoryPath: fullUrl, ref: { kind: 'branch', name: 'main' }, expectedCommitSha: sha }, status: 'READY' };
  await page.route('**/api/v1/git/connections', (route) => json(route, { connections: [saved], tokenStorage: 'ready' }));
  await page.route('**/api/v1/git/connections/*/alias', (route) => {
    const alias = (route.request().postDataJSON() as { alias: string }).alias;
    if (alias) saved = { ...saved, alias };
    else { const { alias: _oldAlias, ...withoutAlias } = saved; saved = withoutAlias; }
    return json(route, { connection: saved });
  });
  await page.route('**/api/v1/git/registrations', (route) => json(route, { registrations: [registration] }));
  await page.route('**/api/v1/git/registrations/*/alias', (route) => {
    registration.alias = (route.request().postDataJSON() as { alias: string }).alias || undefined;
    return json(route, { registration });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openConnections(page);
  const accounts = page.getByRole('region', { name: 'Git 계정 연결' });
  await accounts.getByRole('button', { name: '별칭 설정' }).click();
  await accounts.getByLabel('별칭', { exact: true }).fill('커넥스 운영');
  await accounts.getByRole('button', { name: '별칭 저장' }).click();
  await expect(accounts.getByText('커넥스 운영', { exact: true })).toBeVisible();
  expect(saved.repositoryPath).toBe(fullUrl);
  await openSettings(page, false);
  const branches = page.getByRole('region', { name: '등록 배포 브랜치' });
  await branches.getByRole('button', { name: '별칭 설정' }).click();
  await branches.getByLabel('별칭', { exact: true }).fill('운영 배포');
  await branches.getByRole('button', { name: '별칭 저장' }).click();
  await expect(branches.getByText('운영 배포 · main', { exact: true })).toBeVisible();
  await page.reload();
  await openConnections(page);
  await expect(accounts.getByText('커넥스 운영', { exact: true })).toBeVisible();
  await openSettings(page, false);
  await expect(branches.getByText('운영 배포 · main', { exact: true })).toBeVisible();
  await openConnections(page);
  await accounts.getByRole('button', { name: '별칭 변경' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(accounts.getByLabel('별칭', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await accounts.getByRole('button', { name: '취소', exact: true }).click();
  await page.goto('http://127.0.0.1:27546/deploy');
  const select = page.getByLabel('DESIRED SOURCE 비교 소스');
  await expect(select.locator(`option[value="git-connection:${connectionId}"]`)).toContainText('커넥스 운영');
  await select.selectOption(`git-connection:${connectionId}`);
  await expect(page.locator('#source-git-branch-heading')).toContainText('커넥스 운영');
  await openConnections(page);
  await accounts.getByRole('button', { name: '별칭 변경' }).click();
  await accounts.getByLabel('별칭', { exact: true }).fill('');
  await accounts.getByRole('button', { name: '별칭 저장' }).click();
  await expect(accounts.getByText('group/long-project-name', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('메타데이터 상태 탭과 검색을 결합하고 동일 항목·페이지·배포 선택을 유지한다', async ({ page }) => {
  const component = (fullName: string, status: string) => ({ key: `ApexClass:${fullName}`, type: 'ApexClass', fullName, status,
    files: [{ path: `classes/${fullName}.cls`, status, kind: 'text' }] });
  const all = [
    ...Array.from({ length: 23 }, (_, i) => component(`New${String(i).padStart(2, '0')}`, 'ADDED')),
    component('TargetOld', 'REMOVED'), component('Changed', 'MODIFIED'), component('Same', 'IDENTICAL'),
  ];
  await mockGitApis(page, { extraSources: [readySource()] });
  const fullJob = comparisonFixture({ mode: 'compare', status: 'SUCCEEDED', rightSourceId: `git:${importId}`, components: all });
  await page.route('**/api/v1/comparisons', (route) => route.request().method() === 'GET'
    ? json(route, { jobs: [] }) : json(route, { job: { ...fullJob, result: { ...fullJob.result, components: all.filter((item) => item.status !== 'IDENTICAL') } } }, 202));
  let identicalRequests = 0;
  await page.route('**/api/v1/comparisons/comparison-e2e?includeIdentical=true', async (route) => {
    identicalRequests++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return json(route, { job: fullJob });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(`git:${importId}`);
  await page.getByRole('button', { name: '메타데이터 받아오기', exact: true }).click();
  const result = page.locator('.comparison-result');
  const rows = result.locator('.component-result');
  await expect(rows).toHaveCount(20);
  await result.getByRole('checkbox', { name: 'New00 배포 대상으로 선택' }).check();
  await result.getByRole('button', { name: '다음 페이지' }).click();
  await expect(rows).toHaveCount(5);
  await result.getByRole('button', { name: /^NEW/u }).click();
  await expect(rows).toHaveCount(20);
  await expect(result.getByRole('checkbox', { name: 'New00 배포 대상으로 선택' })).toBeChecked();
  await result.getByLabel('메타데이터 검색', { exact: true }).fill(' NEW22 ');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('New22');
  await expect(result.getByRole('navigation')).toHaveCount(0);
  await result.getByRole('button', { name: /^TARGET ONLY/u }).click();
  await expect(rows).toHaveCount(0);
  await result.getByLabel('메타데이터 검색', { exact: true }).fill('');
  await expect(rows).toHaveCount(1);
  await expect(result.getByRole('checkbox', { name: 'TargetOld 배포 대상으로 선택' })).toBeDisabled();
  await result.getByRole('button', { name: /^MODIFIED/u }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Changed');
  await result.getByLabel('메타데이터 검색', { exact: true }).fill('classes/changed.cls');
  await expect(rows).toHaveCount(1);
  await result.getByLabel('메타데이터 검색', { exact: true }).fill('apexclass');
  await expect(rows).toHaveCount(1);
  await result.getByRole('button', { name: /^IDENTICAL/u }).click();
  await expect(result.getByText('동일 항목 불러오는 중…')).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Same');
  await result.getByRole('checkbox', { name: 'Same 배포 대상으로 선택' }).check();
  await result.getByRole('button', { name: '필터 초기화' }).click();
  await expect(rows).toHaveCount(20);
  await expect(result.getByRole('checkbox', { name: 'New00 배포 대상으로 선택' })).toBeChecked();
  await result.getByRole('button', { name: /^IDENTICAL/u }).click();
  await expect(result.getByRole('checkbox', { name: 'Same 배포 대상으로 선택' })).toBeChecked();
  expect(identicalRequests).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(result.getByLabel('메타데이터 검색', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('설정에서 브랜치·태그 로딩 표시가 응답 완료와 실패 후 해제된다', async ({ page }) => {
  await mockGitApis(page);
  await openSettings(page);
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/project');
  for (const kind of ['branch', 'tag'] as const) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/v1/git/repositories/refs', async (route) => {
      await gate;
      return kind === 'branch' ? json(route, refs(kind)) : json(route, { error: { code: 'GIT_PROCESS_FAILED', message: '태그 조회 실패' } }, 400);
    });
    await page.getByLabel('기준 종류').selectOption(kind);
    await page.getByRole('button', { name: '저장소 확인' }).click();
    const status = page.getByRole('status').filter({ hasText: kind === 'branch' ? '브랜치 불러오는 중…' : '태그 불러오는 중…' });
    try {
      await expect(status).toBeVisible();
      await expect(page.getByLabel('기준 종류')).toBeDisabled();
    } finally { release(); }
    await expect(status).toHaveCount(0);
    await expect(page.getByRole('button', { name: '저장소 확인' })).toBeEnabled();
    if (kind === 'branch') await expect(page.getByLabel('브랜치 선택')).toHaveValue('main');
    else await expect(page.getByRole('alert').filter({ hasText: '태그 조회 실패' })).toBeVisible();
  }
});

test('비교 소스의 브랜치 조회 중 안내와 입력 비활성 상태를 표시한다', async ({ page }) => {
  await mockGitApis(page, { initialConnections: [connection({ repositoryPath: 'owner/project' })] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/git/repositories/refs', async (route) => { await gate; return json(route, refs('branch')); });
  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(`git-connection:${connectionId}`);
  const status = page.getByRole('status').filter({ hasText: '브랜치 불러오는 중…' });
  try {
    await expect(status).toBeVisible();
    await expect(page.getByLabel('브랜치 검색 및 선택')).toBeDisabled();
  } finally { release(); }
  await expect(status).toHaveCount(0);
  await expect(page.getByLabel('브랜치 검색 및 선택')).toBeEnabled();
  await expect(page.getByLabel('브랜치 검색 및 선택')).toHaveValue('main');
});

test('private 계정의 repository를 선택하고 public URL에서 branch/tag/commit을 확인한다', async ({ page }) => {
  const fixture = await mockGitApis(page);
  await openSettings(page);
  const importPanel = page.getByRole('dialog', { name: /^Git 프로젝트(?: 다시)? 가져오기$/u });
  await page.getByLabel('접근 계정').selectOption(connectionId);
  await page.getByRole('button', { name: 'owner/project', exact: true }).click();
  await expect(page.getByLabel('저장소 URL 또는 경로')).toHaveValue('owner/project');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await expect(importPanel.getByText(/비공개/u)).toBeVisible();
  await expect(page.getByLabel('브랜치 선택')).toHaveValue('main');

  await page.getByLabel('기준 종류').selectOption('tag');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await expect(page.getByLabel('태그 선택')).toHaveValue('v1.0.0');
  await page.getByLabel('기준 종류').selectOption('commit');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await page.getByLabel('전체 커밋 SHA').fill(commitSha);
  await expect(page.getByText(commitSha, { exact: true })).toBeVisible();

  await page.getByLabel('접근 계정').selectOption('');
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/public');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await expect(importPanel.getByText('owner/project · 공개', { exact: true })).toBeVisible();
  await importPanel.getByLabel('전체 커밋 SHA').fill(commitSha);
  await expect(importPanel.getByLabel('전체 커밋 SHA')).toHaveValue(commitSha);
  await page.getByLabel('Git 제공자').selectOption('gitlab');
  await page.getByLabel('저장소 URL 또는 경로').fill('group/project');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await expect(importPanel.getByText('owner/project · 공개', { exact: true })).toBeVisible();
  expect(fixture.requestedKinds).toEqual(['branch', 'tag']);
});

test('public import를 상태·루트 선택·READY source와 deploy 화면까지 연결한다', async ({ page }) => {
  await mockGitApis(page);
  await openSettings(page);
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/public');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await page.getByRole('button', { name: '이 커밋 가져오기' }).click();
  await expect(page.getByRole('table', { name: '내 Git 프로젝트' }).getByRole('row', { name: /owner\/project/u })).toContainText('프로젝트 선택 필요');
  await page.getByRole('button', { name: 'force-app 가져오기' }).click();
  const project = page.getByRole('table', { name: '내 Git 프로젝트' }).getByRole('row', { name: /owner\/project/u });
  await expect(project).toContainText('사용 가능');
  await expect(project.locator('time')).toHaveAttribute('dateTime', '2026-09-20T00:00:00.000Z');
  await expect(project).toContainText('가져온 시각');
  await expect(page.getByText('소스를 삭제해도 실행 이력과 이미 준비된 배포 자료는 유지됩니다.', { exact: true })).toBeVisible();
  await expect(project.getByRole('link', { name: '비교 및 배포에서 사용' })).toBeVisible();
  await project.getByRole('link', { name: '비교 및 배포에서 사용' }).click();
  await expect(page).toHaveURL(/\/deploy$/u);
  await expect(page.getByRole('combobox', { name: /DESIRED SOURCE 비교 소스/u })).toHaveValue(`git:${importId}`);
  await expect(page.getByText(`Git · main · ${sha.slice(0, 12)}`, { exact: true })).toBeVisible();
});

test('Settings에서 CustomField를 가져오고 다시 가져오기에서 metadata type을 복원한다', async ({ page }) => {
  const fixture = await mockGitApis(page);
  await openSettings(page);
  const importPanel = page.getByRole('dialog', { name: /^Git 프로젝트(?: 다시)? 가져오기$/u });
  await importPanel.getByLabel('저장소 URL 또는 경로').fill('owner/project');
  await importPanel.getByRole('button', { name: '저장소 확인' }).click();
  const metadataTypeInput = importPanel.getByLabel('가져올 메타데이터 타입');
  await expect(metadataTypeInput).toHaveValue('ApexClass');
  await metadataTypeInput.fill('CustomField');
  await expect(metadataTypeInput).toHaveValue('CustomField');
  await importPanel.getByRole('button', { name: '이 커밋 가져오기' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({
    provider: 'github', repositoryPath: 'https://github.com/owner/project.git',
    ref: { kind: 'branch', name: 'main' }, expectedCommitSha: sha, metadataType: 'CustomField',
  });

  const project = page.getByRole('table', { name: '내 Git 프로젝트' }).getByRole('row', { name: /owner\/project/u });
  await expect(project).toContainText('CustomField');
  await page.screenshot({ path: 'working/git-settings-custom-field.png', fullPage: true });

  await project.getByRole('button', { name: 'force-app 가져오기' }).click();
  await expect(project).toContainText('사용 가능');
  await project.getByRole('button', { name: '다시 가져오기' }).click();
  await importPanel.getByRole('button', { name: '저장소 확인' }).click();
  await expect(importPanel.getByLabel('가져올 메타데이터 타입')).toHaveValue('CustomField');
});

test('legacy READY Git source의 metadata type으로 deploy scope를 고정한다', async ({ page }) => {
  const legacy = readySource(historicalImportId, { label: 'legacy/project', provenance: {
    ...readySource(historicalImportId).provenance!, repositoryPath: 'legacy/project', importId: historicalImportId,
    metadataType: 'CustomField',
  } });
  await mockGitApis(page, {
    initialImports: [imported('READY', {
      id: historicalImportId, repositoryPath: 'legacy/project', metadataType: 'CustomField', source: legacy,
    })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  await desiredSource.selectOption(`git:${historicalImportId}`);
  await expect(page.locator('#deploy-scope')).toHaveValue('CustomField');
  await expect(page.locator('#deploy-scope')).toHaveAttribute('readonly', '');
});

test('등록된 Git 저장소를 소스로 선택하고 브랜치를 검색해 READY source로 준비한다', async ({ page }) => {
  const registeredPath = 'acme/registered-project';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  const virtualSourceId = `git-connection:${connectionId}`;
  await expect(desiredSource.locator(`option[value="${virtualSourceId}"]`)).toHaveCount(1);
  await desiredSource.selectOption(virtualSourceId);

  const branchInput = page.getByLabel('브랜치 검색 및 선택');
  await expect(branchInput).toHaveValue('main');
  const metadataTypeInput = page.getByLabel('가져올 메타데이터 타입');
  await expect(metadataTypeInput).toHaveValue('ApexClass');
  await expect(page.locator('#git-branch-options option')).toHaveCount(1);
  await branchInput.fill('');
  await expect(page.locator('#git-branch-options option')).toHaveCount(2);
  expect(fixture.refRequests.at(-1)).toMatchObject({
    provider: 'github', repositoryPath: registeredPath, connectionId, kind: 'branch',
  });

  await branchInput.fill('rel');
  await expect(page.locator('#git-branch-options option')).toHaveCount(1);
  await expect(page.locator('#git-branch-options option')).toHaveAttribute('value', 'release');
  await branchInput.fill('release');
  await expect(page.getByText(`현재 선택: release · 고정할 커밋 ${releaseSha}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({
    provider: 'github', repositoryPath: registeredPath, connectionId,
    ref: { kind: 'branch', name: 'release' }, expectedCommitSha: releaseSha,
    metadataType: 'ApexClass',
  });

  await expect(page.getByRole('button', { name: 'force-app 선택' })).toBeVisible();
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect(desiredSource).toHaveValue(virtualSourceId);
  await expect(desiredSource.locator(`option[value="${virtualSourceId}"]`)).toHaveCount(1);
  await expect(desiredSource.locator('option')).toHaveCount(2);
});

test('CustomField를 선택해 준비하면 import 요청과 deploy scope가 같은 타입으로 고정된다', async ({ page }) => {
  const registeredPath = 'acme/custom-field-project';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  await desiredSource.selectOption(`git-connection:${connectionId}`);
  const metadataTypeInput = page.getByLabel('가져올 메타데이터 타입');
  await expect(metadataTypeInput).toHaveValue('ApexClass');
  await metadataTypeInput.fill('CustomField');
  await expect(metadataTypeInput).toHaveValue('CustomField');
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  await page.screenshot({ path: 'working/git-deploy-metadata-type.png', fullPage: true });
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({
    provider: 'github', repositoryPath: registeredPath, connectionId,
    ref: { kind: 'branch', name: 'release' }, expectedCommitSha: releaseSha,
    metadataType: 'CustomField',
  });

  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect(page.locator('#deploy-scope')).toHaveValue('CustomField');
  await expect(page.locator('#deploy-scope')).toHaveAttribute('readonly', '');
  await expect(metadataTypeInput).toHaveValue('CustomField');
  await expect(desiredSource.locator(`option[value="git-connection:${connectionId}"]`)).toHaveCount(1);
  await expect(desiredSource.locator('option')).toHaveCount(2);
});

test('지원하지 않는 metadata type은 Git source 준비를 비활성화한다', async ({ page }) => {
  await mockGitApis(page, { initialConnections: [connection({ repositoryPath: 'acme/invalid-type-project' })] });

  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(`git-connection:${connectionId}`);
  const metadataTypeInput = page.getByLabel('가져올 메타데이터 타입');
  const prepareButton = page.getByRole('button', { name: '이 브랜치로 소스 준비' });
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  await metadataTypeInput.fill('DefinitelyNotSalesforceMetadata');
  await expect(metadataTypeInput).toHaveValue('DefinitelyNotSalesforceMetadata');
  await expect(prepareButton).toBeDisabled();
  await metadataTypeInput.fill('ApexClass');
  await expect(prepareButton).toBeEnabled();
});

test('metadata type 변경은 READY source를 무효화하고 다음 import에 새 타입을 사용한다', async ({ page }) => {
  const registeredPath = 'acme/metadata-type-race';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  await desiredSource.selectOption(`git-connection:${connectionId}`);
  const metadataTypeInput = page.getByLabel('가져올 메타데이터 타입');
  const branchInput = page.getByLabel('브랜치 검색 및 선택');
  await metadataTypeInput.fill('CustomField');
  await branchInput.fill('release');
  const prepareButton = page.getByRole('button', { name: '이 브랜치로 소스 준비' });
  await prepareButton.click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({ metadataType: 'CustomField' });
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect(page.locator('#deploy-scope')).toHaveValue('CustomField');
  await expect(page.locator('#deploy-scope')).toHaveAttribute('readonly', '');

  await metadataTypeInput.fill('ApexClass');
  await expect(metadataTypeInput).toHaveValue('ApexClass');
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toHaveCount(0);
  await expect(page.locator('#deploy-scope')).toBeDisabled();
  await expect(prepareButton).toBeEnabled();
  await prepareButton.click();
  await expect.poll(() => fixture.importRequests.length).toBe(2);
  expect(fixture.importRequests[1]).toMatchObject({ metadataType: 'ApexClass' });
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toBeVisible();
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect.poll(() => fixture.selectedImportIds.length).toBe(2);
  expect(fixture.selectedImportIds).toEqual([importId, secondImportId]);
  await expect(desiredSource).toHaveValue(`git-connection:${connectionId}`);
  await expect(metadataTypeInput).toHaveValue('ApexClass');
});

test('READY 준비를 반복해도 virtual source 하나를 유지하고 reload 뒤 bound historical source를 숨긴다', async ({ page }) => {
  const registeredPath = 'acme/registered-project';
  const historical = readySource(historicalImportId, { label: registeredPath, provenance: {
    ...readySource(historicalImportId).provenance!, repositoryPath: registeredPath, importId: historicalImportId,
  } });
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
    initialImports: [imported('READY', { id: historicalImportId, repositoryPath: registeredPath, source: historical })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  const virtualSourceId = `git-connection:${connectionId}`;
  await desiredSource.selectOption(virtualSourceId);
  await expect(page.getByLabel('브랜치 검색 및 선택')).toHaveValue('main');
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toBeVisible();
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect(desiredSource).toHaveValue(virtualSourceId);
  await expect(desiredSource.locator(`option[value="${virtualSourceId}"]`)).toHaveCount(1);
  await expect(desiredSource.locator('option[value^="git:"]')).toHaveCount(0);
  await expect(desiredSource.locator('option')).toHaveCount(2);

  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toBeVisible();
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(2);
  expect(fixture.createdImportIds).toEqual([importId, secondImportId]);
  expect(fixture.importRequests.map((request) => request.metadataType)).toEqual(['ApexClass', 'ApexClass']);
  await expect(desiredSource.locator(`option[value="${virtualSourceId}"]`)).toHaveCount(1);
  await expect(desiredSource.locator('option[value^="git:"]')).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스')).toHaveValue(virtualSourceId);
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스').locator(`option[value="${virtualSourceId}"]`)).toHaveCount(1);
  await expect(page.getByLabel('DESIRED SOURCE 비교 소스').locator('option[value^="git:"]')).toHaveCount(0);
});

test('READY Git source는 metadata와 source-only comparison에 내부 source id를 사용한다', async ({ page }) => {
  const registeredPath = 'acme/registered-project';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  const virtualSourceId = `git-connection:${connectionId}`;
  await desiredSource.selectOption(virtualSourceId);
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await page.getByRole('button', { name: 'force-app 선택' }).click();
  await expect(desiredSource).toHaveValue(virtualSourceId);
  const internalSourceId = `git:${importId}`;
  await expect(page.locator('#deploy-scope')).toHaveValue('ApexClass');
  await expect(page.locator('#deploy-scope')).toHaveAttribute('readonly', '');

  await page.getByRole('checkbox', { name: '현재 타입 비교 실행' }).uncheck();
  await page.getByRole('button', { name: '메타데이터 받아오기' }).click();
  await expect.poll(() => fixture.comparisonRequests.length).toBe(1);
  expect(fixture.comparisonRequests[0]).toMatchObject({ rightSourceId: internalSourceId, sourceOnly: true });
  expect(fixture.comparisonRequests[0]).not.toHaveProperty('leftSourceId');
});

test('Git import 실패 alert 뒤 같은 branch를 재시도할 수 있다', async ({ page }) => {
  const registeredPath = 'acme/registered-project';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
  });
  fixture.setCreateError({ code: 'REF_CHANGED', message: '기준 커밋이 변경되었습니다. 다시 확인하세요.' });

  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(`git-connection:${connectionId}`);
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect(page.getByRole('alert')).toContainText('기준 커밋이 변경되었습니다');
  expect(fixture.importRequests).toHaveLength(0);

  fixture.setCreateError(undefined);
  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toBeVisible();
  expect(fixture.importRequests).toHaveLength(1);
  expect(fixture.importRequests[0]).toMatchObject({ metadataType: 'ApexClass' });
});

test('source를 바꾼 뒤 늦게 끝난 import 응답을 버리고 중복 준비를 잠근다', async ({ page }) => {
  const registeredPath = 'acme/registered-project';
  const historical = readySource(historicalImportId, { label: 'legacy/project', provenance: {
    ...readySource(historicalImportId).provenance!, repositoryPath: 'legacy/project', importId: historicalImportId,
  } });
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ repositoryPath: registeredPath, displayName: '등록 저장소 연결' })],
    initialImports: [imported('READY', { id: historicalImportId, repositoryPath: 'legacy/project', source: historical })],
  });
  fixture.setImportDelay(150);

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  await desiredSource.selectOption(`git-connection:${connectionId}`);
  await page.getByLabel('브랜치 검색 및 선택').fill('release');
  const prepareButton = page.getByRole('button', { name: '이 브랜치로 소스 준비' });
  await prepareButton.click();
  await expect(page.getByRole('button', { name: '브랜치 소스 준비 중……' })).toBeDisabled();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  expect(fixture.importRequests[0]).toMatchObject({ metadataType: 'ApexClass' });
  await desiredSource.selectOption(`git:${historicalImportId}`);
  await expect(desiredSource).toHaveValue(`git:${historicalImportId}`);
  await page.waitForTimeout(220);
  await expect(desiredSource).toHaveValue(`git:${historicalImportId}`);
  await expect(page.getByRole('button', { name: 'force-app 선택' })).toHaveCount(0);
});

test('desktop/mobile에서 deploy Git branch panel이 overflow와 브라우저 오류 없이 렌더링된다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await mockGitApis(page, { initialConnections: [connection({ repositoryPath: 'acme/registered-project' })] });
  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(`git-connection:${connectionId}`);
  await expect(page.getByLabel('브랜치 검색 및 선택')).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('button, input, select, label')].filter((element) => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map((element) => element.textContent ?? element.getAttribute('aria-label')),
    }));
    expect(metrics.overflow, `${width}px horizontal overflow`).toBe(false);
    expect(metrics.clipped, `${width}px clipped controls`).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.screenshot({ path: 'working/git-deploy-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'working/git-deploy-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('재인증이 필요한 등록 저장소는 비교 및 배포 소스로 제공하지 않는다', async ({ page }) => {
  const registeredPath = 'acme/reauth-project';
  await mockGitApis(page, {
    initialConnections: [connection({
      repositoryPath: registeredPath, displayName: '재인증 필요 연결', status: 'REAUTH_REQUIRED',
    })],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  await expect(desiredSource.locator(`option[value="git-connection:${connectionId}"]`)).toHaveCount(0);
  await expect(page.getByLabel('브랜치 검색 및 선택')).toHaveCount(0);
});

test('PAT를 등록하고 교체하며 secret이 브라우저 저장소에 남지 않는다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [] });
  await openConnections(page);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('account');
  await page.getByLabel('토큰 제공자').selectOption('github');
  const token = 'ghp-e2e-token-value';
  await page.getByLabel('PAT / API Token').fill('discarded-modal-token');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByRole('button', { name: '새 연결', exact: true })).toBeFocused();
  await openNewConnection(page);
  await expect(page.getByLabel('PAT / API Token')).toHaveValue('');
  expect(fixture.tokenRequests).toHaveLength(0);
  await page.getByLabel('연결 범위').selectOption('account');
  fixture.setTokenError({ code: 'GIT_CONNECTION_FAILED', message: '토큰 검증 실패' });
  await page.getByLabel('PAT / API Token').fill('ghp-failing-token');
  await page.getByRole('button', { name: '토큰 검증 후 등록' }).click();
  await expect(page.getByRole('alert')).toContainText('토큰 검증 실패');
  await expect(page.getByLabel('PAT / API Token')).toHaveValue('');
  await page.screenshot({ path: 'working/git-token-error.png', fullPage: true });
  expect(await browserStorage(page)).not.toContain('ghp-failing-token');
  fixture.setTokenError(undefined);
  await page.getByLabel('PAT / API Token').fill(token);
  await page.getByRole('button', { name: '토큰 검증 후 등록' }).click();
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText('github token account', { exact: true })).toBeVisible();
  expect(fixture.tokenRequests.at(-1)).toMatchObject({ provider: 'github', token });
  expect(fixture.csrfHeaders.every((header) => header.length > 0)).toBe(true);
  expect(await browserStorage(page)).not.toContain(token);
  await expect(page.getByRole('dialog', { name: 'Git 프로젝트 가져오기' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'owner/project', exact: true })).toBeVisible();
  expect(fixture.catalogRequests.length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  await page.getByRole('region', { name: 'Git 계정 연결' }).getByRole('button', { name: /^github token account/u }).click();
  await expect(page.getByLabel('PAT / API Token')).toHaveValue('');
  await page.getByLabel('PAT / API Token').fill('ghp-e2e-replacement');
  await page.getByRole('button', { name: '검증 후 설정 저장' }).click();
  expect(fixture.tokenRequests.at(-1)).toMatchObject({ provider: 'github', token: 'ghp-e2e-replacement' });
  expect(await browserStorage(page)).not.toContain('ghp-e2e-replacement');
});

test('계정 연결 설정에서 목록을 다시 조회하고 저장소 선택을 가져오기로 이어간다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [connection({ displayName: '내 계정' })] });
  await openConnections(page);
  await page.getByRole('button', { name: /^내 계정/u }).click();
  const settings = page.getByRole('dialog', { name: 'Git 연결 설정' });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel('PAT / API Token')).toHaveValue('');
  await expect(settings.getByLabel('별칭', { exact: true })).not.toHaveAttribute('placeholder', '예: 커넥스 운영');
  await settings.getByRole('button', { name: '저장소 목록 조회', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Git 프로젝트 가져오기' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'owner/project', exact: true }).click();
  await expect(picker.getByLabel('저장소 URL 또는 경로')).toHaveValue('owner/project');
  await picker.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await expect(picker.getByLabel('브랜치 선택')).toHaveValue('main');
  expect(fixture.catalogRequests.length).toBeGreaterThan(0);
});

test('등록된 저장소 연결을 클릭해 대상을 바꾸고 검증 실패 시 설정을 유지한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [connection({ displayName: '기존 저장소', repositoryPath: 'owner/project' })] });
  await openConnections(page);
  await page.getByRole('button', { name: /^기존 저장소/u }).click();
  const settings = page.getByRole('dialog', { name: 'Git 연결 설정' });
  await settings.getByLabel('연결할 저장소 URL').fill('owner/changed');
  fixture.setTokenError({ code: 'REPOSITORY_UNAVAILABLE', message: '대상 확인 실패' });
  await settings.getByLabel('PAT / API Token').fill('replacement-fixture');
  await settings.getByRole('button', { name: '검증 후 설정 저장' }).click();
  await expect(settings.getByRole('alert')).toContainText('대상 확인 실패');
  await expect(settings.getByLabel('PAT / API Token')).toHaveValue('');
  expect(fixture.tokenRequests.at(-1)).toMatchObject({ changeTarget: true, repositoryPath: 'owner/changed' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table', { name: 'Git 연결 목록' })).toContainText('owner/project');
});

test('GitHub fine-grained·classic PAT 붙여넣기의 앞뒤 공백과 개행을 정리하고 공유 계약을 통과한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [] });
  await openConnections(page);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('account');
  const tokenInput = page.getByLabel('PAT / API Token');
  const cases: Array<{ pasted: string; token: string; expiry?: string; expiresAt?: string }> = [
    {
      pasted: '\ngithub_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\t ',
      token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      expiry: '2027-09-20',
      expiresAt: '2027-09-20T23:59:59.999Z',
    },
    {
      pasted: '  ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
      token: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  ];

  for (const [index, value] of cases.entries()) {
    if (index > 0) await page.getByRole('button', { name: '토큰 교체' }).click();
    await tokenInput.fill(value.pasted);
    if (value.expiry !== undefined) await page.getByLabel('만료일').fill(value.expiry);
    await expect(page.getByRole('button', { name: index === 0 ? '토큰 검증 후 등록' : '검증 후 설정 저장' })).toBeEnabled();
    await page.getByRole('button', { name: index === 0 ? '토큰 검증 후 등록' : '검증 후 설정 저장' }).click();
    await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText('github token account', { exact: true })).toBeVisible();
    expect(fixture.tokenRequests.at(-1)).toMatchObject({ provider: 'github', token: value.token,
      ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) });
    if (index === 0) {
      await expect(page.getByRole('dialog', { name: 'Git 프로젝트 가져오기' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(fixture.tokenRequests).toHaveLength(2);
});

test('토큰 내부 공백은 구체적인 입력 오류를 보여주고 제공자 요청을 보내지 않는다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [] });
  await openConnections(page);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('account');
  await page.getByLabel('토큰 제공자').selectOption('github');
  await page.getByLabel('PAT / API Token').fill('github_pat_11AAAA AAAA');
  await page.getByRole('button', { name: '토큰 검증 후 등록' }).click();
  await expect(page.getByRole('alert')).toContainText('토큰 원문만 입력하세요. 토큰 내부에 공백·줄바꿈이 포함되어 있습니다.');
  expect(fixture.tokenRequests).toHaveLength(0);
  await expect(page.getByLabel('PAT / API Token')).toHaveValue('');
});

test('Bitbucket token에는 Atlassian 이메일과 선택적 만료일을 함께 보낸다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [] });
  await openConnections(page);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('account');
  await page.getByLabel('토큰 제공자').selectOption('bitbucket');
  await expect(page.getByLabel('Atlassian 계정 이메일')).toBeVisible();
  await expect(page.getByLabel('만료일')).toBeVisible();
  await page.getByLabel('PAT / API Token').fill('bb-e2e-token');
  await page.getByLabel('Atlassian 계정 이메일').fill('atlassian@example.com');
  await page.getByLabel('만료일').fill('2027-09-20');
  await page.screenshot({ path: 'working/git-token-bitbucket.png', fullPage: true });
  await page.getByRole('button', { name: '토큰 검증 후 등록' }).click();
  expect(fixture.tokenRequests.at(-1)).toMatchObject({
    provider: 'bitbucket', token: 'bb-e2e-token', apiUsername: 'atlassian@example.com', expiresAt: '2027-09-20T23:59:59.999Z',
  });
  expect(fixture.csrfHeaders.every((header) => header.length > 0)).toBe(true);
});

test('세 제공자의 저장소 단위 연결은 계정 API·Bitbucket 이메일 없이 경로를 보존하고 가져오기에 자동 연결한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [], allProvidersConfigured: true });
  await openConnections(page);
  const cases = [
    { provider: 'github', path: 'https://github.com/acme/github-project.git', token: 'github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { provider: 'gitlab', path: 'https://gitlab.com/study-group8144838/git-project.git', token: 'glpat-AAAAAAAAAAAAAAAAAAAA' },
    { provider: 'bitbucket', path: 'https://bitbucket.org/acme/bitbucket-project.git', token: 'ATBB-AAAAAAAAAAAAAAAAAAAA' },
  ] as const;

  for (const [index, value] of cases.entries()) {
    await openNewConnection(page);
    await page.getByLabel('연결 범위').selectOption('repository');
    await page.getByLabel('토큰 제공자').selectOption(value.provider);
    await page.getByLabel('연결할 저장소 URL').fill(value.path);
    await page.getByLabel('PAT / API Token').fill(` ${value.token}\n`);
    await page.getByRole('button', { name: '토큰 검증 후 등록' }).click();
    const displayName = value.provider === 'bitbucket' ? 'Bitbucket token account' : `${value.provider} token account`;
    const canonicalPath = value.path.replace(/^https:\/\/[^/]+\//u, '').replace(/\.git$/u, '');
    await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText(displayName, { exact: true })).toBeVisible();
    expect(fixture.tokenRequests.at(-1)).toMatchObject({ provider: value.provider, token: value.token, repositoryPath: value.path });
    if (value.provider === 'bitbucket') expect(fixture.tokenRequests.at(-1)).not.toHaveProperty('apiUsername');
    expect(fixture.catalogRequests).toHaveLength(0);
    await openSettings(page);
    const importPanel = page.getByRole('dialog', { name: /^Git 프로젝트(?: 다시)? 가져오기$/u });
    await importPanel.getByLabel('Git 제공자').selectOption(value.provider);
    await importPanel.getByLabel('접근 계정').selectOption(connectionId);
    await expect(importPanel).toContainText(`이 연결은 ${canonicalPath} 저장소에서만 사용할 수 있습니다.`);
    await expect(importPanel.getByLabel('저장소 URL 또는 경로')).toHaveValue(canonicalPath);
    await openConnections(page);

    if (index === 0) {
      await page.getByRole('button', { name: '토큰 교체' }).click();
      await expect(page.getByLabel('연결할 저장소 URL')).toHaveValue(canonicalPath);
      await page.getByLabel('PAT / API Token').fill('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      await page.getByRole('button', { name: '검증 후 설정 저장' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(fixture.tokenRequests.at(-1)).toMatchObject({ provider: 'github', repositoryPath: canonicalPath });
    }
  }
});

test('저장소 단위 연결은 URL 빈값·공백 상태에서 토큰을 입력해도 등록 버튼을 비활성화한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [] });
  await openConnections(page);
  await openNewConnection(page);
  await page.getByLabel('연결 범위').selectOption('repository');
  const submit = page.getByRole('button', { name: '토큰 검증 후 등록' });
  await page.getByLabel('PAT / API Token').fill('github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await expect(submit).toBeDisabled();
  await page.getByLabel('연결할 저장소 URL').fill('   ');
  await expect(submit).toBeDisabled();
  await page.getByRole('region', { name: 'Git 계정 연결' }).locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByRole('alert')).toContainText('연결할 저장소 URL을 입력하세요.');
  expect(fixture.tokenRequests).toHaveLength(0);
});

test('만료 연결을 표시하고 Git 저장 키 설정 안내는 숨긴다', async ({ page }) => {
  const expired = connection({ status: 'REAUTH_REQUIRED', expiresAt: '2026-01-01T00:00:00.000Z' });
  await mockGitApis(page, { initialConnections: [expired], tokenStorage: 'invalid_key', environmentAvailable: false });
  await openConnections(page);
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText(/토큰 교체 필요/u)).toBeVisible();
  await expect(page.getByText(/암호화 키 설정|토큰을 저장하려면 관리자가/u)).toHaveCount(0);
  await openNewConnection(page);
  await expect(page.getByText('서버의 토큰 저장 설정을 확인하세요.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '환경변수 토큰 등록' })).toHaveCount(0);
});

test('준비된 저장소의 환경변수 token import를 수행한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialConnections: [], tokenStorage: 'ready', environmentAvailable: true });
  await openConnections(page);
  await openNewConnection(page);
  await expect(page.getByRole('button', { name: '환경변수 토큰 등록' })).toBeVisible();
  await page.getByRole('button', { name: '환경변수 토큰 등록' }).click();
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText('github token account', { exact: true })).toBeVisible();
  expect(fixture.tokenRequests).toEqual([]);
  expect(fixture.csrfHeaders.every((header) => header.length > 0)).toBe(true);
});

test('refchanged와 재연결 필요 오류를 표시하고 cancel/delete를 수행한다', async ({ page }) => {
  const fixture = await mockGitApis(page, { initialImports: [imported('FETCHING')] });
  fixture.setCreateError({ code: 'REF_CHANGED', message: '기준 커밋이 변경되었습니다. 다시 확인하세요.' });
  await openSettings(page);
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/public');
  await page.getByRole('button', { name: '저장소 확인' }).click();
  await page.getByRole('button', { name: '이 커밋 가져오기' }).click();
  await expect(page.getByRole('alert')).toContainText('기준 커밋이 변경되었습니다');
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.getByRole('button', { name: '가져오기 취소' })).toBeVisible();
  await page.getByRole('button', { name: '가져오기 취소' }).click();
  await expect(page.getByText('취소됨', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '소스 삭제' }).click();
  await expect(page.getByText('가져온 Git 프로젝트가 없습니다.')).toBeVisible();

  await openConnections(page);
  await expect(page.getByRole('button', { name: '토큰 교체' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Git 계정 연결' }).getByText('GitHub private account', { exact: true })).toBeVisible();
});

test('Org→Git target은 비교 전용으로 제한하고 org로 바꾸면 배포 흐름을 복원한다', async ({ page }) => {
  const targetConnectionId = '55555555-5555-4555-8555-555555555555';
  const sourceOrg: WorkspaceResponse['sources'][number] = {
    id: 'org:source', kind: 'org', location: 'org', label: 'source', detail: '연결된 org',
    username: 'source@example.com', maskedOrgId: '00D-source',
  };
  const comparisonComponent = {
    key: 'ApexClass:Hello', type: 'ApexClass', fullName: 'Hello', status: 'ADDED',
    files: [{ path: 'classes/Hello.cls', status: 'ADDED', before: '', after: 'public class Hello {}' }],
  };
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ id: targetConnectionId, repositoryPath: 'acme/target-project' })],
    extraSources: [sourceOrg], comparisonComponents: [comparisonComponent],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  const target = page.getByLabel('TARGET 비교 소스');
  await desiredSource.selectOption(sourceOrg.id);
  await target.selectOption(`git-connection:${targetConnectionId}`);

  const targetBranch = page.getByLabel('타겟 브랜치 검색 및 선택');
  const targetMetadata = page.getByLabel('타겟 메타데이터 타입');
  await expect(targetBranch).toBeVisible();
  await expect(targetBranch).toHaveValue('main');
  await targetBranch.fill('release');
  await expect(targetMetadata).toHaveValue('ApexClass');
  await page.getByRole('button', { name: '이 브랜치로 타겟 준비' }).click();
  await expect(page.getByRole('button', { name: /force-app 선택/u })).toBeVisible();
  await page.getByRole('button', { name: /force-app 선택/u }).click();
  await expect(target).toHaveValue(`git-connection:${targetConnectionId}`);

  await expect(page.locator('p[role="status"]').filter({ hasText: 'Git 타겟은 비교 전용입니다' })).toBeVisible();
  const compare = page.getByRole('button', { name: '메타데이터 받아오기' });
  await expect(compare).toBeEnabled();
  await compare.click();
  await expect(page.getByRole('heading', { name: /owner\/project → source|source → owner\/project/u })).toBeVisible();
  expect(fixture.comparisonRequests[0]).toMatchObject({ leftSourceId: `git:${importId}`, rightSourceId: sourceOrg.id });
  const componentCheckbox = page.getByRole('checkbox', { name: 'Hello 배포 대상으로 선택' });
  await expect(componentCheckbox).toBeDisabled();
  await expect(page.getByRole('button', { name: /Dry-run/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /실제 배포/ })).toBeDisabled();

  await target.selectOption(targetSource.id);
  await expect(target).toHaveValue(targetSource.id);
  await expect(page.getByLabel('타겟 브랜치 검색 및 선택')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Apex 테스트 설정' })).toBeVisible();
  await expect(compare).toBeEnabled();
  await compare.click();
  const orgComponentCheckbox = page.getByRole('checkbox', { name: 'Hello 배포 대상으로 선택' });
  await expect(orgComponentCheckbox).toBeEnabled();
  await orgComponentCheckbox.check();
  await expect(page.locator('button.button-primary')).toHaveCount(1);
  await expect(page.locator('button.button-primary')).toBeEnabled();
  expect(fixture.comparisonRequests[1]).toMatchObject({ leftSourceId: targetSource.id, rightSourceId: sourceOrg.id });
  expect(fixture.importRequests[0]).toMatchObject({ metadataType: 'ApexClass', ref: { name: 'release' } });
});

test('Git→Git source와 target은 브랜치·metadata type을 각각 준비하고 selector option 수를 유지한다', async ({ page }) => {
  const sourceConnectionId = '66666666-6666-4666-8666-666666666666';
  const targetConnectionId = '77777777-7777-4777-8777-777777777777';
  const sourceConnection = connection({ id: sourceConnectionId, repositoryPath: 'acme/source-project' });
  const targetConnection = connection({ id: targetConnectionId, repositoryPath: 'acme/target-project' });
  const comparisonComponent = {
    key: 'ApexClass:Hello', type: 'ApexClass', fullName: 'Hello', status: 'MODIFIED',
    files: [{ path: 'classes/Hello.cls', status: 'MODIFIED', before: 'old', after: 'new' }],
  };
  const fixture = await mockGitApis(page, {
    initialConnections: [sourceConnection, targetConnection], comparisonComponents: [comparisonComponent],
  });

  await page.goto('http://127.0.0.1:27546/deploy');
  const desiredSource = page.getByLabel('DESIRED SOURCE 비교 소스');
  const target = page.getByLabel('TARGET 비교 소스');
  await desiredSource.selectOption(`git-connection:${sourceConnectionId}`);
  await target.selectOption(`git-connection:${targetConnectionId}`);
  const sourceBranch = page.getByLabel('브랜치 검색 및 선택', { exact: true });
  const targetBranch = page.getByLabel('타겟 브랜치 검색 및 선택');
  const sourceMetadata = page.getByLabel('가져올 메타데이터 타입');
  const targetMetadata = page.getByLabel('타겟 메타데이터 타입');
  await expect(sourceBranch).toHaveValue('main');
  await expect(targetBranch).toHaveValue('main');
  const sourceOptionCount = await desiredSource.locator('option').count();
  const targetOptionCount = await target.locator('option').count();
  await sourceBranch.fill('release');
  await targetBranch.fill('main');
  await expect(sourceMetadata).toHaveValue('ApexClass');
  await expect(targetMetadata).toHaveValue('ApexClass');

  await page.getByRole('button', { name: '이 브랜치로 소스 준비' }).click();
  await expect(page.getByRole('button', { name: /force-app 선택/u })).toBeVisible();
  await page.getByRole('button', { name: /force-app 선택/u }).click();
  await page.getByRole('button', { name: '이 브랜치로 타겟 준비' }).click();
  await expect(page.getByRole('button', { name: /force-app 선택/u })).toBeVisible();
  await page.getByRole('button', { name: /force-app 선택/u }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(2);
  expect(fixture.importRequests.map((request) => request.metadataType)).toEqual(['ApexClass', 'ApexClass']);
  await expect(desiredSource.locator('option')).toHaveCount(sourceOptionCount);
  await expect(target.locator('option')).toHaveCount(targetOptionCount);
  await expect(page.locator('p[role="status"]').filter({ hasText: 'Git 타겟은 비교 전용입니다' })).toBeVisible();

  await page.getByRole('button', { name: '메타데이터 받아오기' }).click();
  expect(fixture.comparisonRequests[0]).toMatchObject({ leftSourceId: `git:${secondImportId}`, rightSourceId: `git:${importId}` });
  await expect(page.getByRole('checkbox', { name: 'Hello 배포 대상으로 선택' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Dry-run/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /실제 배포/ })).toBeDisabled();

  await targetMetadata.fill('CustomField');
  await page.getByRole('button', { name: '이 브랜치로 타겟 준비' }).click();
  await expect(page.getByRole('button', { name: /force-app 선택/u })).toBeVisible();
  await page.getByRole('button', { name: /force-app 선택/u }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(3);
  await expect(page.getByText('소스와 타겟의 Git 메타데이터 타입을 동일하게 선택하고 다시 준비하세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '메타데이터 받아오기' })).toBeDisabled();
  expect(fixture.importRequests.at(-1)).toMatchObject({ metadataType: 'CustomField' });
});

test('타겟 Git 브랜치를 바꾼 뒤 늦게 끝난 준비 응답을 버리고 최신 요청만 반영한다', async ({ page }) => {
  const sourceOrg: WorkspaceResponse['sources'][number] = {
    id: 'org:source', kind: 'org', location: 'org', label: 'source', detail: '연결된 org',
    username: 'source@example.com', maskedOrgId: '00D-source',
  };
  const targetConnectionId = '88888888-8888-4888-8888-888888888888';
  const fixture = await mockGitApis(page, {
    initialConnections: [connection({ id: targetConnectionId, repositoryPath: 'acme/target-project' })], extraSources: [sourceOrg],
  });
  fixture.setImportDelays([150, 0]);

  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(sourceOrg.id);
  await page.getByLabel('TARGET 비교 소스').selectOption(`git-connection:${targetConnectionId}`);
  const targetBranch = page.getByLabel('타겟 브랜치 검색 및 선택');
  await expect(targetBranch).toHaveValue('main');
  await targetBranch.fill('release');
  await page.getByRole('button', { name: '이 브랜치로 타겟 준비' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(1);
  const target = page.getByLabel('TARGET 비교 소스');
  await target.selectOption(targetSource.id);
  await target.selectOption(`git-connection:${targetConnectionId}`);
  const latestTargetBranch = page.getByLabel('타겟 브랜치 검색 및 선택');
  await expect(latestTargetBranch).toHaveValue('main');
  await page.getByRole('button', { name: '이 브랜치로 타겟 준비' }).click();
  await expect.poll(() => fixture.importRequests.length).toBe(2);
  await expect(page.getByRole('button', { name: /force-app 선택/u })).toBeVisible();
  await page.getByRole('button', { name: /force-app 선택/u }).click();
  await expect.poll(() => fixture.selectedImportIds).toEqual([secondImportId]);
  await page.waitForTimeout(220);
  await expect(latestTargetBranch).toHaveValue('main');
  expect(fixture.selectedImportIds).toEqual([secondImportId]);
});

test('desktop/mobile에서 Git target panel이 overflow와 브라우저 오류 없이 렌더링된다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const targetConnectionId = '99999999-9999-4999-8999-999999999999';
  const sourceOrg: WorkspaceResponse['sources'][number] = {
    id: 'org:source', kind: 'org', location: 'org', label: 'source', detail: '연결된 org',
    username: 'source@example.com', maskedOrgId: '00D-source',
  };
  await mockGitApis(page, {
    initialConnections: [connection({ id: targetConnectionId, repositoryPath: 'acme/target-project' })], extraSources: [sourceOrg],
  });
  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(sourceOrg.id);
  await page.getByLabel('TARGET 비교 소스').selectOption(`git-connection:${targetConnectionId}`);
  await expect(page.getByLabel('타겟 브랜치 검색 및 선택')).toBeVisible();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('button, input, select, label')].filter((element) => {
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map((element) => element.textContent ?? element.getAttribute('aria-label')),
    }));
    expect(metrics.overflow, `${width}px horizontal overflow`).toBe(false);
    expect(metrics.clipped, `${width}px clipped controls`).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.screenshot({ path: 'working/git-target-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'working/git-target-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('desktop/mobile에서 Git settings가 overflow와 브라우저 오류 없이 렌더링된다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await mockGitApis(page, { initialImports: [imported('READY', { source: readySource() })] });
  await openSettings(page, false);
  await expect(page.getByRole('table', { name: '내 Git 프로젝트' }).getByRole('row', { name: /owner\/project/u })).toContainText('가져온 시각');
  for (const width of [1280, 430, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('button, input, select, a')].filter((element) => {
        if (element.closest('.connection-table-scroll')) return false;
        const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
      }).map((element) => element.textContent ?? element.getAttribute('aria-label')),
    }));
    expect(metrics.overflow, `${width}px horizontal overflow`).toBe(false);
    expect(metrics.clipped, `${width}px clipped controls`).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.screenshot({ path: 'working/git-ui-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'working/git-ui-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.screenshot({ path: 'working/git-ui-320.png', fullPage: true });
  expect(errors).toEqual([]);
});


test('배포 브랜치를 설정에서 등록하고 동기화 상태·자동 비교 소스를 표시한다', async ({ page }) => {
  const sourceId = 'git-registered:55555555-5555-4555-8555-555555555555';
  const mocks = await mockGitApis(page, { extraSources: [{ id: sourceId, kind: 'local', location: 'git', label: 'owner/project · main', detail: '등록 브랜치 · 비교 시작 시 자동 동기화' }] });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  let registration: Record<string, unknown> | undefined;
  let syncs = 0;
  await page.route('**/api/v1/git/registrations', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      registration = { id: sourceId.slice('git-registered:'.length), request: { ...request, repositoryPath: canonicalRepositoryPath(request.repositoryPath) }, status: 'READY', lastCommitSha: sha, lastSyncedAt: '2026-09-21T00:00:00.000Z' };
      return json(route, { registration }, 201);
    }
    return json(route, { registrations: registration ? [registration] : [] });
  });
  await page.route('**/api/v1/git/registrations/*/sync', (route) => { syncs++; return json(route, { registration }); });
  await openSettings(page);
  await page.getByLabel('저장소 URL 또는 경로').fill('owner/project');
  await page.getByRole('button', { name: '저장소 확인', exact: true }).click();
  await page.getByRole('button', { name: '배포 브랜치 등록', exact: true }).click();
  const panel = page.getByRole('region', { name: '등록 배포 브랜치' });
  await expect(panel.getByText('owner/project · main', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '지금 동기화' }).click();
  await expect.poll(() => syncs).toBe(1);
  await expect(panel.getByText(sha, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole('button', { name: '지금 동기화' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.getByRole('link', { name: '비교에서 사용' }).click();
  await expect(page.getByText('owner/project · main', { exact: true }).first()).toBeVisible();
  expect(registration?.request).toMatchObject({ ref: { kind: 'branch', name: 'main' }, projectRoot: '.' });
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(sourceId);
  await page.getByRole('button', { name: '메타데이터 받아오기', exact: true }).click();
  await expect.poll(() => mocks.comparisonRequests.length).toBe(1);
  expect(mocks.comparisonRequests[0]).toMatchObject({ rightSourceId: sourceId, metadataType: 'ApexClass' });
  expect(errors).toEqual([]);
});


test('등록 브랜치의 dry-run은 비교에서 확정한 Git 소스 ID를 사용한다', async ({ page }) => {
  const registeredId = 'git-registered:55555555-5555-4555-8555-555555555555';
  const frozenId = `git:${importId}`;
  await mockGitApis(page, { extraSources: [{ id: registeredId, kind: 'local', location: 'git', label: 'owner/project · main' }] });
  await page.route('**/api/v1/comparisons', async (route) => {
    if (route.request().method() === 'GET') return json(route, { jobs: [] });
    expect(route.request().postDataJSON().rightSourceId).toBe(registeredId);
    return json(route, { job: { ...comparisonFixture({ mode: 'compare', status: 'SUCCEEDED', rightSourceId: frozenId, leftSourceId: targetSource.id,
      components: [{ key: 'ApexClass:Hello', type: 'ApexClass', fullName: 'Hello', status: 'MODIFIED', files: [] }] }), right: readySource() } }, 202);
  });
  let dryRun: Record<string, unknown> | undefined;
  await page.route('**/api/v1/deployments/dry-run', async (route) => {
    dryRun = route.request().postDataJSON();
    return json(route, { error: { code: 'FIXTURE_STOP', message: '요청 소스 확인 완료' } }, 400);
  });
  await page.goto('http://127.0.0.1:27546/deploy');
  await page.getByLabel('DESIRED SOURCE 비교 소스').selectOption(registeredId);
  await page.getByRole('button', { name: '메타데이터 받아오기', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hello 배포 대상으로 선택' }).check();
  await page.getByLabel('테스트 수준').selectOption('RunLocalTests');
  await page.getByRole('button', { name: '배포 대상 Dry-run' }).click();
  await expect.poll(() => dryRun?.sourceId).toBe(frozenId);
  await expect(page.getByText(sha, { exact: true })).toBeVisible();
  expect(dryRun?.targetOrgId).toBe(targetSource.id);
});
