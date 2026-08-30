import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';

const METADATA_RESULTS_PER_PAGE = 20;

type IconName =
  | 'activity'
  | 'arrow'
  | 'check'
  | 'chevron'
  | 'clock'
  | 'cloud'
  | 'code'
  | 'compare'
  | 'deploy'
  | 'folder'
  | 'history'
  | 'home'
  | 'key'
  | 'logout'
  | 'plus'
  | 'refresh'
  | 'settings'
  | 'shield'
  | 'trash'
  | 'user';

interface HealthResponse {
  status: 'ok';
  service: 'sfud-ui';
  version: string;
  host: string;
  port: number;
  storage?: {
    engine: 'sqlite';
    status: 'ok';
  };
  queue?: {
    activeJobId?: string;
    queuedCount: number;
  };
  comparisonQueue?: {
    activeJobId?: string;
    queuedCount: number;
  };
  recoveredJobCount?: number;
  recoveredComparisonCount?: number;
}

interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  role: 'VIEWER' | 'OPERATOR' | 'DEPLOYER' | 'ADMIN';
}

interface AuthStatusResponse {
  setupRequired: boolean;
  authenticated: boolean;
  user?: ApiUser;
}

interface AdminUser extends ApiUser {
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceSource {
  id: string;
  kind: 'org' | 'local';
  location?: 'org' | 'server' | 'upload';
  label: string;
  detail: string;
  expiresAt?: string;
}

interface WorkspaceProject {
  id: string;
  displayName: string;
  manifests: string[];
}

interface WorkspaceResponse {
  sources: WorkspaceSource[];
  projects: WorkspaceProject[];
  uploads?: WorkspaceProject[];
}

interface MetadataTypeOption {
  name: string;
  directoryName: string;
}

interface ComparisonJobResponse {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  scope?: 'all' | 'manifest';
  metadataType?: string;
  manifest: string;
  left: { id: string; kind: 'org' | 'local'; label: string };
  right: { id: string; kind: 'org' | 'local'; label: string };
  errorMessage?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  summary?: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
  result?: {
    summary: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
    warnings: string[];
    components: ComparisonComponent[];
  };
}

interface ComparisonComponent {
  key: string;
  type: string;
  fullName: string;
  status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL';
  files: Array<{ path: string; status: string; unifiedDiff?: string; xmlChanges?: Array<{ path: string; before?: string; after?: string }> }>;
}

interface DeploymentCartItem {
  key: string;
  type: string;
  fullName: string;
}

interface DryRunJobResponse {
  id: string;
  kind: 'DRY_RUN' | 'DEPLOY';
  status: 'QUEUED' | 'DRY_RUN_RUNNING' | 'APPROVAL_PENDING' | 'DEPLOYING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  source: { id: string; kind: 'org' | 'local'; label: string };
  target: { id: string; kind: 'org'; label: string };
  manifest: string;
  scope?: 'all' | 'manifest' | 'selected';
  metadataType?: string;
  components?: Array<{ type: string; fullName: string }>;
  prepared: boolean;
  payloadChecksum?: string;
  salesforceDeploymentId?: string;
  progress?: {
    phase: 'DRY_RUN' | 'DEPLOY';
    deploymentId: string;
    status: string;
    done: boolean;
    success?: boolean;
    numberComponentsDeployed?: number;
    numberComponentsTotal?: number;
    numberComponentErrors?: number;
    numberTestsCompleted?: number;
    numberTestsTotal?: number;
    numberTestErrors?: number;
    checkedAt: string;
  };
  testPlan?: { level: string; tests: string[]; selection: string };
  testCoverage?: number;
  comparisonSummary?: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
  comparison?: ComparisonJobResponse['result'];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

interface WorkflowEventMessage {
  resource: 'comparison' | 'deployment';
  jobId: string;
  kind: string;
  status: string;
  updatedAt: string;
}

type LiveStatus = 'connecting' | 'connected' | 'reconnecting';

interface DashboardRun {
  id: string;
  kind: string;
  source: string;
  target: string;
  summary: string;
  time: string;
  tone: string;
  createdAt: string;
}

type PageKey = 'home' | 'deploy' | 'runs' | 'settings' | 'admin';

const ALL_METADATA_LABEL = '전체 메타데이터';

const pageMeta: Record<PageKey, { eyebrow: string; title: string }> = {
  home: { eyebrow: 'METADATA WORKSPACE', title: '배포 대시보드' },
  deploy: { eyebrow: 'COMPARE & DEPLOY', title: '비교 및 배포' },
  runs: { eyebrow: 'RUN HISTORY', title: '실행 기록' },
  settings: { eyebrow: 'SERVER CONFIGURATION', title: '설정' },
  admin: { eyebrow: 'ACCESS CONTROL', title: '사용자 관리' },
};

const navigation: Array<{ icon: IconName; label: string; page: PageKey; href: string }> = [
  { icon: 'home', label: '홈', page: 'home', href: '/' },
  { icon: 'deploy', label: '비교 및 배포', page: 'deploy', href: '/deploy' },
  { icon: 'history', label: '실행 기록', page: 'runs', href: '/runs' },
];

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [auth, setAuth] = useState<AuthStatusResponse | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [dashboardWorkspace, setDashboardWorkspace] = useState<WorkspaceResponse | null>(null);
  const [recentComparisons, setRecentComparisons] = useState<ComparisonJobResponse[]>([]);
  const [recentDeployments, setRecentDeployments] = useState<DryRunJobResponse[]>([]);
  const currentPage = getCurrentPage();
  const currentMeta = pageMeta[currentPage];
  const remoteAccess = health !== null && !['127.0.0.1', 'localhost', '::1'].includes(health.host);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('health check failed');
        setHealth(await response.json() as HealthResponse);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealthFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/auth/status', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('auth status failed');
        setAuth(await response.json() as AuthStatusResponse);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAuthFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    document.title = `${currentMeta.title} · sfud`;
  }, [currentMeta.title]);

  useEffect(() => {
    if (auth?.authenticated !== true) return;
    const controller = new AbortController();
    void Promise.all([
      fetch('/api/v1/workspace', { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => response.ok && setDashboardWorkspace(await response.json() as WorkspaceResponse)),
      fetch('/api/v1/comparisons', { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => response.ok && setRecentComparisons((await response.json() as { jobs: ComparisonJobResponse[] }).jobs)),
      fetch('/api/v1/deployment-jobs', { credentials: 'same-origin', signal: controller.signal })
        .then(async (response) => response.ok && setRecentDeployments((await response.json() as { jobs: DryRunJobResponse[] }).jobs)),
    ]).catch(() => undefined);
    return () => controller.abort();
  }, [auth?.authenticated]);

  if (auth === null) {
    return <AuthLoading failed={authFailed} />;
  }

  if (!auth.authenticated || auth.user === undefined) {
    return <AuthScreen setupRequired={auth.setupRequired} onAuthenticated={(user) => setAuth({
      setupRequired: false,
      authenticated: true,
      user,
    })} />;
  }

  const recentRuns = [
    ...recentComparisons.map(toDashboardRun),
    ...recentDeployments.map(toDashboardDryRun),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30);
  const connectedOrgCount = dashboardWorkspace?.sources.filter((source) => source.kind === 'org').length ?? 0;
  const projectCount = dashboardWorkspace?.projects.length ?? 0;
  const latestRun = recentRuns[0];
  const visibleNavigation = auth.user.role === 'ADMIN'
    ? [...navigation, { icon: 'user' as const, label: '사용자 관리', page: 'admin' as const, href: '/admin' }]
    : navigation;

  const logout = async () => {
    const response = await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
    });
    if (response.ok) setAuth({ setupRequired: false, authenticated: false });
  };

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-slate-950">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="sfud 홈">
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <span>
            <strong>sfud</strong>
            <small>Deployment Console</small>
          </span>
        </a>

        <nav className="nav-list" aria-label="주요 메뉴">
          {visibleNavigation.map((item) => (
            <a
              key={item.label}
              className={currentPage === item.page ? 'nav-item nav-item-active' : 'nav-item'}
              href={item.href}
              aria-label={item.label}
              aria-current={currentPage === item.page ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <a className={currentPage === 'settings' ? 'nav-item nav-item-active' : 'nav-item'} href="/settings" aria-label="설정" aria-current={currentPage === 'settings' ? 'page' : undefined}>
            <Icon name="settings" />
            <span>설정</span>
          </a>
          <div className="safety-note">
            <Icon name="shield" />
            <span><strong>{remoteAccess ? '원격 연결 허용' : '로컬 전용 연결'}</strong>{remoteAccess ? '외부 공개 주소로 실행 중입니다.' : '인증 정보는 브라우저에 저장하지 않습니다.'}</span>
          </div>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <div>
            <p className="eyebrow">{currentMeta.eyebrow}</p>
            <h1>{currentMeta.title}</h1>
          </div>
          <div className="status-row" aria-live="polite">
            <StatusPill
              label={healthFailed ? 'UI 연결 오류' : health ? `UI ${health.port}` : 'UI 확인 중'}
              state={healthFailed ? 'error' : health ? 'online' : 'pending'}
            />
            <StatusPill label={dashboardWorkspace === null ? 'Salesforce CLI 확인 중' : 'Salesforce CLI 연결됨'} state={dashboardWorkspace === null ? 'pending' : 'online'} />
            <div className="org-count"><Icon name="cloud" /><strong>{connectedOrgCount}</strong><span>ORG</span></div>
            <div className="account-menu" title={auth.user.email}>
              <span><Icon name="user" /></span>
              <div><strong>{auth.user.displayName}</strong><small>{auth.user.role}</small></div>
              <button type="button" onClick={() => void logout()} aria-label="로그아웃"><Icon name="logout" /></button>
            </div>
          </div>
        </header>

        <main id="main" className="content">
          {currentPage === 'home' && <>
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="eyebrow text-blue-700">SAFE BY DEFAULT</p>
              <h2 id="hero-title">변경을 먼저 확인하고,<br />확신이 들 때 배포하세요.</h2>
              <p>두 Salesforce 환경의 메타데이터를 한눈에 비교하고<br className="desktop-only" /> 동일한 payload로 안전하게 검증합니다.</p>
              <div className="hero-actions">
                <a className="button button-primary" href="/deploy">
                  <Icon name="compare" />비교 및 배포 시작<Icon name="arrow" />
                </a>
              </div>
            </div>
            <div className="hero-visual" aria-label="stdOrg에서 aladin org로의 비교 예시">
              <div className="orb orb-one" />
              <div className="orb orb-two" />
              <div className="compare-flow">
                <EnvironmentBadge label="stdOrg" subtitle="Developer" initials="ST" />
                <div className="flow-center">
                  <span>LEFT</span>
                  <div className="flow-line"><i /><Icon name="arrow" /></div>
                  <span>RIGHT</span>
                </div>
                <EnvironmentBadge label="aladin" subtitle="Sandbox" initials="AL" />
              </div>
              <div className="diff-preview">
                <div><span className="diff-dot diff-added" />NEW<strong>38</strong></div>
                <div><span className="diff-dot diff-removed" />TARGET ONLY<strong>5</strong></div>
                <div><span className="diff-dot diff-modified" />변경<strong>0</strong></div>
              </div>
            </div>
          </section>

          <section className="overview-grid" aria-label="연결 상태">
            <OverviewCard
              icon="cloud"
              title="연결된 Salesforce org"
              value={String(connectedOrgCount)}
              detail={dashboardWorkspace === null ? '연결 확인 중' : '연결된 org'}
              action="org 관리"
              tone="blue"
            >
              <div className="avatar-stack"><span>ST</span><span>AL</span><i /></div>
            </OverviewCard>
            <OverviewCard
              icon="folder"
              title="서버 DX 프로젝트"
              value={String(projectCount)}
              detail={dashboardWorkspace?.projects[0]?.displayName ?? '프로젝트 확인 중'}
              action="프로젝트 열기"
              tone="violet"
            >
              <div className="path-chip"><Icon name="code" /> ./force-app</div>
            </OverviewCard>
            <OverviewCard
              icon="activity"
              title="최근 실행"
              value={latestRun === undefined ? '없음' : latestRun.tone === 'green' ? '성공' : latestRun.tone === 'amber' ? '실패' : '실행 중'}
              detail={latestRun === undefined ? '실행 기록 없음' : latestRun.time}
              action="결과 보기"
              tone="green"
            >
              <div className="success-chip"><Icon name="check" /> {latestRun?.summary ?? '비교 및 배포를 시작하세요'}</div>
            </OverviewCard>
          </section>

          <section className="runs-section" aria-labelledby="recent-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">RUN HISTORY</p>
                <h2 id="recent-title">최근 실행</h2>
              </div>
              <a className="text-button" href="/runs">전체 기록 보기 <Icon name="arrow" /></a>
            </div>
            <div className="runs-list">
              {recentRuns.length === 0 ? <p className="empty-runs">아직 저장된 비교 실행이 없습니다.</p> : recentRuns.map((run) => <RunRow key={run.id} {...run} />)}
            </div>
          </section>

          <section className="tip-panel">
            <span className="tip-icon"><Icon name="shield" /></span>
            <div>
              <strong>삭제는 자동으로 실행되지 않습니다.</strong>
              <p>비교 결과의 <b>TARGET ONLY</b> 항목은 destructive manifest 없이는 대상 org에서 삭제되지 않습니다.</p>
            </div>
            <button type="button" aria-label="안전 정책 자세히 보기"><Icon name="chevron" /></button>
          </section>
          </>}
          {currentPage === 'deploy' && <DeployPage user={auth.user} />}
          {currentPage === 'runs' && <RunsPage runs={recentRuns} comparisons={recentComparisons} deployments={recentDeployments} />}
          {currentPage === 'settings' && <SettingsPage user={auth.user} health={health} remoteAccess={remoteAccess} workspace={dashboardWorkspace} />}
          {currentPage === 'admin' && (auth.user.role === 'ADMIN'
            ? <AdminPage currentUser={auth.user} />
            : <AdminAccessDenied />)}
        </main>
      </div>
    </div>
  );
}

function getCurrentPage(): PageKey {
  const routeMap: Record<string, PageKey> = {
    '/': 'home',
    '/compare': 'deploy',
    '/deploy': 'deploy',
    '/runs': 'runs',
    '/settings': 'settings',
    '/admin': 'admin',
  };
  return routeMap[window.location.pathname.replace(/\/$/u, '') || '/'] ?? 'home';
}

function ComparePage({ user }: { user: ApiUser }) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [metadataTypes, setMetadataTypes] = useState<MetadataTypeOption[]>([]);
  const [metadataTypesLoading, setMetadataTypesLoading] = useState(false);
  const [scopeQuery, setScopeQuery] = useState(ALL_METADATA_LABEL);
  const [leftSourceId, setLeftSourceId] = useState('');
  const [rightSourceId, setRightSourceId] = useState('');
  const [showIdentical, setShowIdentical] = useState(false);
  const [job, setJob] = useState<ComparisonJobResponse | null>(null);
  const [error, setError] = useState('');
  const canRun = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/workspace', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as WorkspaceResponse & { error?: { message: string } };
        if (!response.ok) throw new Error(data.error?.message ?? '작업 공간을 불러오지 못했습니다.');
        setWorkspace(data);
        setLeftSourceId(data.sources[0]?.id ?? '');
        setRightSourceId(data.sources[1]?.id ?? '');
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '작업 공간을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (leftSourceId.length === 0 || rightSourceId.length === 0) return;
    const controller = new AbortController();
    setMetadataTypesLoading(true);
    const sourceIds = encodeURIComponent(`${leftSourceId},${rightSourceId}`);
    fetch(`/api/v1/metadata-types?sourceIds=${sourceIds}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as {
          metadataTypes?: MetadataTypeOption[];
          error?: { message: string };
        };
        if (!response.ok || data.metadataTypes === undefined) {
          throw new Error(data.error?.message ?? 'Salesforce metadata type을 불러오지 못했습니다.');
        }
        setMetadataTypes(data.metadataTypes);
        setScopeQuery(ALL_METADATA_LABEL);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Salesforce metadata type을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataTypesLoading(false);
      });
    return () => controller.abort();
  }, [leftSourceId, rightSourceId]);

  useEffect(() => {
    if (job === null || !['QUEUED', 'RUNNING'].includes(job.status)) return;
    const timeout = window.setTimeout(() => {
      fetch(`/api/v1/comparisons/${job.id}`, { credentials: 'same-origin' })
        .then(async (response) => {
          const data = await response.json() as { job?: ComparisonJobResponse; error?: { message: string } };
          if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '비교 상태를 확인하지 못했습니다.');
          setJob(data.job);
        })
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : '비교 상태를 확인하지 못했습니다.'));
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [job]);

  const running = job !== null && ['QUEUED', 'RUNNING'].includes(job.status);
  const selectedMetadataType = metadataTypes.find((entry) =>
    entry.name.toLowerCase() === scopeQuery.trim().toLowerCase());
  const scopeValid = scopeQuery === ALL_METADATA_LABEL || selectedMetadataType !== undefined;

  const runComparison = async () => {
    setError('');
    setJob(null);
    try {
      const response = await fetch('/api/v1/comparisons', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify({
          scope: 'all',
          ...(selectedMetadataType === undefined ? {} : { metadataType: selectedMetadataType.name }),
          leftSourceId,
          rightSourceId,
          strict: false,
          showIdentical,
        }),
      });
      const data = await response.json() as { job?: ComparisonJobResponse; error?: { message: string } };
      if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '비교를 시작하지 못했습니다.');
      setJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '비교를 시작하지 못했습니다.');
    }
  };

  return (
    <div className="page-stack">
      <PageIntro
        kicker="NEW COMPARISON"
        title="어떤 환경의 차이를 확인할까요?"
        description="LEFT와 RIGHT의 배포 가능한 메타데이터를 같은 범위로 비교합니다. 아직 어떤 메타데이터도 변경하지 않습니다."
      />

      <section className="workflow-panel" aria-labelledby="source-heading">
        <div className="panel-heading">
          <span className="step-number">01</span>
          <div><h2 id="source-heading">비교 소스 선택</h2><p>연결된 org 또는 허용된 로컬 DX 프로젝트를 선택하세요.</p></div>
          <span className="panel-state">{workspace === null ? '조회 중' : `${workspace.sources.length}개`}</span>
        </div>
        <div className="source-grid">
          <WorkspaceSourceSelect side="LEFT" value={leftSourceId} sources={workspace?.sources ?? []} onChange={setLeftSourceId} tone="blue" />
          <div className="direction-marker"><span>비교 방향</span><Icon name="arrow" /></div>
          <WorkspaceSourceSelect side="RIGHT" value={rightSourceId} sources={workspace?.sources ?? []} onChange={setRightSourceId} tone="violet" />
        </div>
      </section>

      <section className="workflow-panel" aria-labelledby="scope-heading">
        <div className="panel-heading">
          <span className="step-number">02</span>
          <div><h2 id="scope-heading">비교 범위</h2><p>Salesforce metadata type 전체에서 검색하거나 전체 범위를 선택하세요.</p></div>
          <span className="panel-state">필수</span>
        </div>
        <div className="compare-scope-grid metadata-scope-grid">
          <label><span className="field-label">Salesforce metadata type</span>
            <input
              id="compare-scope"
              list="salesforce-metadata-types"
              value={scopeQuery}
              onChange={(event) => setScopeQuery(event.target.value)}
              placeholder="metadata type 검색"
              autoComplete="off"
              disabled={workspace === null || metadataTypesLoading}
              aria-invalid={!scopeValid}
            />
            <datalist id="salesforce-metadata-types">
              <option value={ALL_METADATA_LABEL}>모든 배포 가능 metadata</option>
              {metadataTypes.map((entry) => <option key={entry.name} value={entry.name}>{entry.directoryName}</option>)}
            </datalist>
          </label>
        </div>
        <p className={`field-hint${scopeValid ? '' : ' field-hint-error'}`}><Icon name="check" />{
          metadataTypesLoading
            ? 'Salesforce metadata type을 불러오는 중입니다.'
            : scopeValid
              ? `${metadataTypes.length}개 metadata type 검색 가능 · 양쪽 소스의 합집합으로 비교`
              : '목록에 있는 Salesforce metadata type을 선택하세요.'
        }</p>
      </section>

      <section className="workflow-panel compact-panel" aria-labelledby="options-heading">
        <div className="panel-heading">
          <span className="step-number">03</span>
          <div><h2 id="options-heading">표시 옵션</h2><p>리포트에 동일 항목을 포함할지 선택합니다.</p></div>
        </div>
        <div className="option-grid">
          <OptionToggle title="동일 항목 표시" description="IDENTICAL 컴포넌트도 결과에 포함" checked={showIdentical} onChange={setShowIdentical} />
        </div>
      </section>

      {error && <section className="compare-error" role="alert"><strong>비교를 실행하지 못했습니다.</strong><p>{error}</p></section>}
      {job !== null && <ComparisonResultPanel job={job} />}

      <div className="action-bar">
        <div><Icon name="shield" /><span><strong>읽기 전용 작업</strong>{canRun ? '비교 과정에서는 org를 변경하지 않습니다.' : 'VIEWER 역할은 기존 결과만 조회할 수 있습니다.'}</span></div>
        <button className="button button-primary" type="button" onClick={() => void runComparison()} disabled={!canRun || running || workspace === null || metadataTypesLoading || !scopeValid || !leftSourceId || !rightSourceId}><Icon name={running ? 'refresh' : 'compare'} />{running ? '비교 실행 중……' : '비교 실행'}<Icon name="arrow" /></button>
      </div>
    </div>
  );
}

function DeployPage({ user }: { user: ApiUser }) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [metadataTypes, setMetadataTypes] = useState<MetadataTypeOption[]>([]);
  const [metadataTypesLoading, setMetadataTypesLoading] = useState(false);
  const [scopeQuery, setScopeQuery] = useState(ALL_METADATA_LABEL);
  const [sourceId, setSourceId] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [testLevel, setTestLevel] = useState('auto');
  const [tests, setTests] = useState('');
  const [showIdentical, setShowIdentical] = useState(false);
  const [comparisonJob, setComparisonJob] = useState<ComparisonJobResponse | null>(null);
  const [dryRunJob, setDryRunJob] = useState<DryRunJobResponse | null>(null);
  const [deploymentJob, setDeploymentJob] = useState<DryRunJobResponse | null>(null);
  const [deploymentCart, setDeploymentCart] = useState<DeploymentCartItem[]>([]);
  const [targetConfirmation, setTargetConfirmation] = useState('');
  const [deploymentConfirmation, setDeploymentConfirmation] = useState('');
  const [error, setError] = useState('');
  const [apexTestClasses, setApexTestClasses] = useState<string[]>([]);
  const [apexTestClassQuery, setApexTestClassQuery] = useState('');
  const [apexTestClassesLoading, setApexTestClassesLoading] = useState(false);
  const [apexTestClassesError, setApexTestClassesError] = useState('');
  const [testInputFocused, setTestInputFocused] = useState(false);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const comparisonRequestControllerRef = useRef<AbortController | null>(null);
  const dryRunRequestControllerRef = useRef<AbortController | null>(null);
  const deploymentRequestControllerRef = useRef<AbortController | null>(null);
  const comparisonJobSelectionKeyRef = useRef<string | null>(null);
  const dryRunJobSelectionKeyRef = useRef<string | null>(null);
  const workflowSelectionKey = [sourceId, targetOrgId, scopeQuery, showIdentical].join('\u0000');
  const cartSelectionKey = deploymentCart.map((item) => item.key).sort().join('\u0001');
  const dryRunSelectionKey = [sourceId, targetOrgId, cartSelectionKey, testLevel, tests].join('\u0000');
  const workflowSelectionKeyRef = useRef(workflowSelectionKey);
  const dryRunSelectionKeyRef = useRef(dryRunSelectionKey);
  const comparisonJobRef = useRef(comparisonJob);
  const dryRunJobRef = useRef(dryRunJob);
  const deploymentJobRef = useRef(deploymentJob);
  workflowSelectionKeyRef.current = workflowSelectionKey;
  dryRunSelectionKeyRef.current = dryRunSelectionKey;
  comparisonJobRef.current = comparisonJob;
  dryRunJobRef.current = dryRunJob;
  deploymentJobRef.current = deploymentJob;
  const canRun = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);
  const hasApexDeployment = deploymentCart.some((item) => item.type === 'ApexClass');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/workspace', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as WorkspaceResponse & { error?: { message: string } };
        if (!response.ok) throw new Error(data.error?.message ?? '작업 공간을 불러오지 못했습니다.');
        setWorkspace(data);
        const targetId = data.sources.find((source) => source.kind === 'org')?.id ?? '';
        setTargetOrgId(targetId);
        setSourceId(data.sources.find((source) => source.kind === 'local')?.id
          ?? data.sources.find((source) => source.id !== targetId)?.id
          ?? data.sources[0]?.id
          ?? '');
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '작업 공간을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (sourceId.length === 0 || targetOrgId.length === 0) return;
    const controller = new AbortController();
    setMetadataTypesLoading(true);
    fetch(`/api/v1/metadata-types?sourceIds=${encodeURIComponent(`${sourceId},${targetOrgId}`)}`, {
      credentials: 'same-origin', signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as { metadataTypes?: MetadataTypeOption[]; error?: { message: string } };
        if (!response.ok || data.metadataTypes === undefined) {
          throw new Error(data.error?.message ?? 'Salesforce metadata type을 불러오지 못했습니다.');
        }
        setMetadataTypes(data.metadataTypes);
        setScopeQuery(ALL_METADATA_LABEL);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Salesforce metadata type을 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setMetadataTypesLoading(false); });
    return () => controller.abort();
  }, [sourceId, targetOrgId]);

  useEffect(() => {
    comparisonRequestControllerRef.current?.abort();
    comparisonJobSelectionKeyRef.current = null;
    setComparisonJob(null);
  }, [sourceId, targetOrgId, scopeQuery, showIdentical]);

  useEffect(() => {
    dryRunRequestControllerRef.current?.abort();
    deploymentRequestControllerRef.current?.abort();
    dryRunJobSelectionKeyRef.current = null;
    setDryRunJob(null);
    setDeploymentJob(null);
    setTargetConfirmation('');
    setDeploymentConfirmation('');
  }, [dryRunSelectionKey]);

  useEffect(() => {
    setDeploymentCart([]);
  }, [sourceId, targetOrgId]);

  useEffect(() => {
    if (sourceId.length === 0) {
      setApexTestClasses([]);
      setApexTestClassQuery('');
      setApexTestClassesError('');
      setApexTestClassesLoading(false);
      return;
    }
    if (!hasApexDeployment && !testInputFocused) {
      setApexTestClassesLoading(false);
      return;
    }
    const controller = new AbortController();
    setApexTestClassQuery('');
    setApexTestClassesLoading(true);
    setApexTestClassesError('');
    fetch(`/api/v1/apex-test-classes?sourceId=${encodeURIComponent(sourceId)}`, {
      credentials: 'same-origin', signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as { testClasses?: string[]; error?: { message: string } };
        if (!response.ok || data.testClasses === undefined) {
          throw new Error(data.error?.message ?? 'Apex 테스트 클래스 후보를 불러오지 못했습니다.');
        }
        setApexTestClasses(data.testClasses);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setApexTestClassesError(caught instanceof Error
          ? caught.message
          : 'Apex 테스트 클래스 후보를 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setApexTestClassesLoading(false); });
    return () => controller.abort();
  }, [hasApexDeployment, sourceId, testInputFocused]);

  useEffect(() => {
    const events = new EventSource('/api/v1/workflow/events');
    setLiveStatus('connecting');
    events.onopen = () => setLiveStatus('connected');
    events.onerror = () => setLiveStatus('reconnecting');
    const handleWorkflowEvent = (rawEvent: Event) => {
      if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== 'string') return;
      let event: WorkflowEventMessage;
      try {
        event = JSON.parse(rawEvent.data) as WorkflowEventMessage;
      } catch {
        return;
      }

      if (event.resource === 'comparison' && comparisonJobRef.current?.id === event.jobId) {
        const selectionKey = comparisonJobSelectionKeyRef.current;
        if (selectionKey === null || selectionKey !== workflowSelectionKeyRef.current) return;
        void fetch(`/api/v1/comparisons/${event.jobId}`, { credentials: 'same-origin' })
          .then(async (response) => {
            const data = await response.json() as { job?: ComparisonJobResponse };
            if (
              response.ok
              && data.job !== undefined
              && comparisonJobRef.current?.id === event.jobId
              && comparisonJobSelectionKeyRef.current === selectionKey
              && workflowSelectionKeyRef.current === selectionKey
            ) setComparisonJob(data.job);
          })
          .catch(() => undefined);
        return;
      }

      if (event.resource !== 'deployment') return;
      if (dryRunJobRef.current?.id === event.jobId) {
        const selectionKey = dryRunJobSelectionKeyRef.current;
        if (selectionKey === null || selectionKey !== dryRunSelectionKeyRef.current) return;
        void fetch(`/api/v1/deployment-jobs/${event.jobId}`, { credentials: 'same-origin' })
          .then(async (response) => {
            const data = await response.json() as { job?: DryRunJobResponse };
            if (
              response.ok
              && data.job !== undefined
              && dryRunJobRef.current?.id === event.jobId
              && dryRunJobSelectionKeyRef.current === selectionKey
              && dryRunSelectionKeyRef.current === selectionKey
            ) setDryRunJob(data.job);
          })
          .catch(() => undefined);
      }
      if (deploymentJobRef.current?.id === event.jobId) {
        void fetch(`/api/v1/deployment-jobs/${event.jobId}`, { credentials: 'same-origin' })
          .then(async (response) => {
            const data = await response.json() as { job?: DryRunJobResponse };
            if (response.ok && data.job !== undefined && deploymentJobRef.current?.id === event.jobId) {
              setDeploymentJob(data.job);
            }
          })
          .catch(() => undefined);
      }
    };
    events.addEventListener('workflow', handleWorkflowEvent);
    return () => {
      events.removeEventListener('workflow', handleWorkflowEvent);
      events.close();
    };
  }, []);

  useEffect(() => {
    if (comparisonJob === null || !['QUEUED', 'RUNNING'].includes(comparisonJob.status)) return;
    const selectionKey = comparisonJobSelectionKeyRef.current;
    if (selectionKey === null) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      fetch(`/api/v1/comparisons/${comparisonJob.id}`, {
        credentials: 'same-origin', signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json() as { job?: ComparisonJobResponse; error?: { message: string } };
          if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '비교 상태를 확인하지 못했습니다.');
          if (
            controller.signal.aborted
            || workflowSelectionKeyRef.current !== selectionKey
            || comparisonJobSelectionKeyRef.current !== selectionKey
            || data.job.id !== comparisonJob.id
          ) return;
          setComparisonJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : '비교 상태를 확인하지 못했습니다.');
        });
    }, 900);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [comparisonJob]);

  useEffect(() => {
    if (dryRunJob === null || !['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status)) return;
    const selectionKey = dryRunJobSelectionKeyRef.current;
    if (selectionKey === null) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      fetch(`/api/v1/deployment-jobs/${dryRunJob.id}`, {
        credentials: 'same-origin', signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json() as { job?: DryRunJobResponse; error?: { message: string } };
          if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? 'dry-run 상태를 확인하지 못했습니다.');
          if (
            controller.signal.aborted
            || dryRunSelectionKeyRef.current !== selectionKey
            || dryRunJobSelectionKeyRef.current !== selectionKey
            || data.job.id !== dryRunJob.id
          ) return;
          setDryRunJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : 'dry-run 상태를 확인하지 못했습니다.');
        });
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [dryRunJob]);

  useEffect(() => {
    if (deploymentJob === null || !['QUEUED', 'DEPLOYING'].includes(deploymentJob.status)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      fetch(`/api/v1/deployment-jobs/${deploymentJob.id}`, {
        credentials: 'same-origin', signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json() as { job?: DryRunJobResponse; error?: { message: string } };
          if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '배포 상태를 확인하지 못했습니다.');
          if (!controller.signal.aborted && data.job.id === deploymentJob.id) setDeploymentJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : '배포 상태를 확인하지 못했습니다.');
        });
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [deploymentJob]);

  const source = workspace?.sources.find((entry) => entry.id === sourceId);
  const target = workspace?.sources.find((entry) => entry.id === targetOrgId);
  const comparing = comparisonJob !== null && ['QUEUED', 'RUNNING'].includes(comparisonJob.status);
  const dryRunning = dryRunJob !== null && ['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status);
  const deploying = deploymentJob !== null && ['QUEUED', 'DEPLOYING'].includes(deploymentJob.status);
  const testNames = tests.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
  const selectedTestNames = new Set(testNames);
  const normalizedApexTestClassQuery = apexTestClassQuery.trim().toLocaleLowerCase();
  const filteredApexTestClasses = apexTestClasses.filter((testClass) =>
    testClass.toLocaleLowerCase().includes(normalizedApexTestClassQuery));
  const currentTestToken = tests.match(/[^\s,]*$/u)?.[0] ?? '';
  const normalizedCurrentTestToken = currentTestToken.toLocaleLowerCase();
  const directInputSuggestions = normalizedCurrentTestToken.length === 0
    ? []
    : apexTestClasses.filter((testClass) =>
      testClass.toLocaleLowerCase().includes(normalizedCurrentTestToken)
      && !selectedTestNames.has(testClass)).slice(0, 8);
  const directInputSearchOpen = testInputFocused
    && currentTestToken.length > 0
    && ['auto', 'RunSpecifiedTests'].includes(testLevel);
  const testSelectionValid = testLevel !== 'RunSpecifiedTests' || testNames.length > 0;
  const selectedMetadataType = metadataTypes.find((entry) =>
    entry.name.toLowerCase() === scopeQuery.trim().toLowerCase());
  const scopeValid = scopeQuery === ALL_METADATA_LABEL || selectedMetadataType !== undefined;
  const canDeploy = ['DEPLOYER', 'ADMIN'].includes(user.role);
  const targetAlias = targetOrgId.startsWith('org:') ? targetOrgId.slice('org:'.length) : '';
  const deploymentReady = canDeploy
    && deploymentCart.length > 0
    && targetConfirmation === targetAlias
    && deploymentConfirmation === '실제 배포';

  const changeTestLevel = (nextLevel: string) => {
    setTestLevel(nextLevel);
    if (!['auto', 'RunSpecifiedTests'].includes(nextLevel)) setTests('');
  };

  const setApexTestSelected = (testClass: string, selected: boolean) => {
    const next = new Set(testNames);
    if (selected) next.add(testClass);
    else next.delete(testClass);
    setTests([...next].sort((left, right) => left.localeCompare(right)).join(', '));
    if (selected && !['auto', 'RunSpecifiedTests'].includes(testLevel)) {
      setTestLevel('RunSpecifiedTests');
    }
  };

  const selectDirectTestClass = (testClass: string) => {
    const tokenStart = tests.search(/[^\s,]*$/u);
    setTests(`${tokenStart < 0 ? '' : tests.slice(0, tokenStart)}${testClass}`);
  };

  const setComponentInCart = (component: ComparisonComponent, selected: boolean) => {
    if (component.status === 'REMOVED') return;
    setDeploymentCart((current) => {
      const remaining = current.filter((item) => item.key !== component.key);
      return selected
        ? [...remaining, { key: component.key, type: component.type, fullName: component.fullName }]
          .sort((left, right) => left.type.localeCompare(right.type) || left.fullName.localeCompare(right.fullName))
        : remaining;
    });
  };

  const runComparison = async () => {
    setError('');
    setComparisonJob(null);
    const selectionKey = workflowSelectionKey;
    const controller = new AbortController();
    comparisonRequestControllerRef.current?.abort();
    comparisonRequestControllerRef.current = controller;
    comparisonJobSelectionKeyRef.current = selectionKey;
    try {
      const response = await fetch('/api/v1/comparisons', {
        method: 'POST', credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify({
          scope: 'all',
          ...(selectedMetadataType === undefined ? {} : { metadataType: selectedMetadataType.name }),
          leftSourceId: targetOrgId,
          rightSourceId: sourceId,
          strict: false,
          showIdentical,
        }),
      });
      const data = await response.json() as { job?: ComparisonJobResponse; error?: { message: string } };
      if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '비교를 시작하지 못했습니다.');
      if (
        controller.signal.aborted
        || workflowSelectionKeyRef.current !== selectionKey
        || comparisonJobSelectionKeyRef.current !== selectionKey
      ) return;
      setComparisonJob(data.job);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '비교를 시작하지 못했습니다.');
    } finally {
      if (comparisonRequestControllerRef.current === controller) {
        comparisonRequestControllerRef.current = null;
      }
    }
  };

  const startDryRun = async () => {
    if (deploymentCart.length === 0 || !testSelectionValid) return;
    setError('');
    setDryRunJob(null);
    setDeploymentJob(null);
    const selectionKey = dryRunSelectionKey;
    const controller = new AbortController();
    dryRunRequestControllerRef.current?.abort();
    dryRunRequestControllerRef.current = controller;
    dryRunJobSelectionKeyRef.current = selectionKey;
    try {
      const response = await fetch('/api/v1/deployments/dry-run', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify({
          scope: 'selected',
          components: deploymentCart.map(({ type, fullName }) => ({ type, fullName })),
          sourceId, targetOrgId, testLevel, tests: testNames, waitMinutes: 60, strict: false,
        }),
      });
      const data = await response.json() as { job?: DryRunJobResponse; error?: { message: string } };
      if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? 'dry-run을 시작하지 못했습니다.');
      if (
        controller.signal.aborted
        || dryRunSelectionKeyRef.current !== selectionKey
        || dryRunJobSelectionKeyRef.current !== selectionKey
      ) return;
      setDryRunJob(data.job);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'dry-run을 시작하지 못했습니다.');
    } finally {
      if (dryRunRequestControllerRef.current === controller) {
        dryRunRequestControllerRef.current = null;
      }
    }
  };

  const executeDeployment = async () => {
    if (!deploymentReady) return;
    setError('');
    setDeploymentJob(null);
    const selectionKey = dryRunSelectionKey;
    const controller = new AbortController();
    deploymentRequestControllerRef.current?.abort();
    deploymentRequestControllerRef.current = controller;
    try {
      const approvedDryRun = dryRunJob?.status === 'APPROVAL_PENDING'
        && dryRunJob.payloadChecksum !== undefined;
      const response = await fetch(approvedDryRun
        ? '/api/v1/deployments/execute'
        : '/api/v1/deployments/direct', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify(approvedDryRun
          ? {
            dryRunJobId: dryRunJob.id,
            payloadChecksum: dryRunJob.payloadChecksum,
            targetAlias,
            confirmation: deploymentConfirmation,
          }
          : {
            scope: 'selected',
            components: deploymentCart.map(({ type, fullName }) => ({ type, fullName })),
            sourceId,
            targetOrgId,
            tests: testNames,
            waitMinutes: 60,
            strict: false,
            targetConfirmation,
            confirmation: deploymentConfirmation,
          }),
      });
      const data = await response.json() as { job?: DryRunJobResponse; error?: { message: string } };
      if (!response.ok || data.job === undefined) throw new Error(data.error?.message ?? '실제 배포를 시작하지 못했습니다.');
      if (!controller.signal.aborted && dryRunSelectionKeyRef.current === selectionKey) {
        setDeploymentJob(data.job);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '실제 배포를 시작하지 못했습니다.');
    } finally {
      if (deploymentRequestControllerRef.current === controller) deploymentRequestControllerRef.current = null;
    }
  };

  return (
    <div className="page-stack">
      <PageIntro kicker="COMPARE, SELECT, DEPLOY" title="검색한 메타데이터를 배포 대상으로 선택합니다." description="metadata type을 바꿔가며 필요한 컴포넌트를 선택하고, 배포 대상 목록만 Salesforce dry-run한 뒤 동일 payload를 배포합니다.">
        <div className="stepper" aria-label="배포 단계"><span className="step-active"><i>1</i>검색</span><b /><span className={deploymentCart.length > 0 ? 'step-active' : ''}><i>2</i>배포 대상</span><b /><span className={dryRunJob !== null ? 'step-active' : ''}><i>3</i>Dry-run</span><b /><span className={deploymentJob !== null ? 'step-active' : ''}><i>4</i>배포</span></div>
      </PageIntro>

      <div className="deploy-layout">
        <div className="page-stack">
          <section className="workflow-panel" aria-labelledby="deploy-source-heading">
            <div className="panel-heading"><span className="step-number">01</span><div><h2 id="deploy-source-heading">소스와 대상</h2><p>배포 기준으로 target → desired source 방향의 차이를 계산합니다.</p></div><span className="panel-state">{workspace === null ? '조회 중' : 'DEPLOY VIEW'}</span></div>
            <div className="deploy-source-grid">
              <WorkspaceSourceSelect side="DESIRED SOURCE" value={sourceId} sources={workspace?.sources ?? []} onChange={setSourceId} tone="violet" />
              <div className="direction-marker"><span>배포 대상</span><Icon name="arrow" /></div>
              <WorkspaceSourceSelect side="TARGET ORG" value={targetOrgId} sources={(workspace?.sources ?? []).filter((entry) => entry.kind === 'org')} onChange={setTargetOrgId} tone="blue" />
            </div>
          </section>

          <section className="workflow-panel" aria-labelledby="deploy-scope-heading">
            <div className="panel-heading"><span className="step-number">02</span><div><h2 id="deploy-scope-heading">메타데이터 검색</h2><p>type별 비교 결과에서 체크한 컴포넌트가 배포 대상 목록에 누적됩니다.</p></div><span className="panel-state">검색</span></div>
            <div className="compare-scope-grid metadata-scope-grid">
              <label><span className="field-label">Salesforce metadata type</span>
                <input id="deploy-scope" list="salesforce-deploy-metadata-types" value={scopeQuery} onChange={(event) => setScopeQuery(event.target.value)} placeholder="metadata type 검색" autoComplete="off" disabled={workspace === null || metadataTypesLoading} aria-invalid={!scopeValid} />
                <datalist id="salesforce-deploy-metadata-types">
                  <option value={ALL_METADATA_LABEL}>모든 배포 가능 metadata</option>
                  {metadataTypes.map((entry) => <option key={entry.name} value={entry.name}>{entry.directoryName}</option>)}
                </datalist>
              </label>
            </div>
            <p className={`field-hint${scopeValid ? '' : ' field-hint-error'}`}><Icon name="check" />{metadataTypesLoading ? 'Salesforce metadata type을 불러오는 중입니다.' : scopeValid ? `${metadataTypes.length}개 metadata type 검색 가능 · source와 target의 합집합` : '목록에 있는 Salesforce metadata type을 선택하세요.'}</p>
          </section>

          <section className="workflow-panel" aria-labelledby="test-heading">
            <div className="panel-heading"><span className="step-number">03</span><div><h2 id="test-heading">Apex 테스트와 표시 옵션</h2><p>비교가 완료되면 선택한 테스트 조건으로 Dry-run을 실행할 수 있습니다.</p></div><span className="auto-badge">{testLevel.toUpperCase()}</span></div>
            <div className="select-row">
              <label><span>테스트 수준</span><select value={testLevel} onChange={(event) => changeTestLevel(event.target.value)}><option value="auto">Auto · 권장</option><option value="RunSpecifiedTests">RunSpecifiedTests</option><option value="RunLocalTests">RunLocalTests</option><option value="RunAllTestsInOrg">RunAllTestsInOrg</option><option value="RunRelevantTests">RunRelevantTests</option><option value="NoTestRun">NoTestRun</option></select></label>
              <div
                className="test-class-input"
                onFocus={() => setTestInputFocused(true)}
                onBlur={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    setTestInputFocused(false);
                  }
                }}
              >
                <label><span>테스트 클래스 직접 입력</span><input
                  className="tests-input"
                  value={tests}
                  onChange={(event) => setTests(event.target.value)}
                  placeholder="AccountService_Test, Other_Test"
                  disabled={!['auto', 'RunSpecifiedTests'].includes(testLevel)}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={directInputSearchOpen}
                  aria-controls="source-apex-test-suggestions"
                /></label>
                {directInputSearchOpen && <div id="source-apex-test-suggestions" className="test-class-suggestions" role="listbox" aria-label="source 테스트 클래스 검색 결과">
                  <div className="test-class-suggestions-head"><span>{source?.label ?? 'source'}에서 검색</span><small>최대 8개</small></div>
                  {apexTestClassesLoading
                    ? <p><Icon name="refresh" />Apex 클래스 검색 중……</p>
                    : apexTestClassesError
                      ? <p className="test-class-suggestions-error">{apexTestClassesError}</p>
                      : directInputSuggestions.length === 0
                        ? <p>일치하는 source Apex 클래스가 없습니다.</p>
                        : directInputSuggestions.map((testClass) => <button key={testClass} type="button" role="option" aria-selected="false" onClick={() => selectDirectTestClass(testClass)}><Icon name="code" />{testClass}</button>)}
                </div>}
              </div>
            </div>
            {hasApexDeployment
              ? <section className="apex-test-picker" aria-label="Apex 테스트 클래스 선택">
                <div className="apex-test-picker-head"><div><strong>Apex 테스트 클래스</strong><p>명명 규칙과 무관하게 desired source의 모든 Apex Class를 표시합니다. 실제 테스트 클래스만 선택하세요.</p></div><span>{testNames.length}개 선택</span></div>
                {apexTestClassesLoading
                  ? <p className="apex-test-message"><Icon name="refresh" />테스트 클래스 조회 중……</p>
                  : apexTestClassesError
                    ? <p className="apex-test-message apex-test-error">{apexTestClassesError} 직접 입력은 계속 사용할 수 있습니다.</p>
                    : apexTestClasses.length === 0
                      ? <p className="apex-test-message">Apex Class 후보가 없습니다. 필요한 클래스는 직접 입력하세요.</p>
                      : <>
                        <label className="apex-test-search"><span>테스트 클래스 검색</span><input value={apexTestClassQuery} onChange={(event) => setApexTestClassQuery(event.target.value)} placeholder="클래스 이름 검색" autoComplete="off" /><small>{filteredApexTestClasses.length} / {apexTestClasses.length}개 표시</small></label>
                        {filteredApexTestClasses.length === 0
                          ? <p className="apex-test-message">검색 조건과 일치하는 Apex Class가 없습니다.</p>
                          : <div className="apex-test-options">{filteredApexTestClasses.map((testClass) => <label key={testClass}><input type="checkbox" checked={selectedTestNames.has(testClass)} disabled={dryRunning || deploying || !['auto', 'RunSpecifiedTests'].includes(testLevel)} onChange={(event) => setApexTestSelected(testClass, event.target.checked)} /><span><Icon name="check" />{testClass}</span></label>)}</div>}
                      </>}
              </section>
              : <p className="apex-test-empty"><Icon name="code" />Apex Class를 배포 대상에 추가하면 테스트 클래스 선택 목록을 불러옵니다.</p>}
            {!testSelectionValid && <p className="apex-test-validation" role="alert">RunSpecifiedTests는 테스트 클래스를 하나 이상 선택하거나 입력해야 합니다.</p>}
            <div className="option-grid">
              <OptionToggle title="동일 항목 표시" description="IDENTICAL 컴포넌트도 결과에 포함" checked={showIdentical} onChange={setShowIdentical} />
            </div>
            <div className="comparison-action">
              <div><Icon name="shield" /><span><strong>읽기 전용 비교</strong>현재 metadata type과 옵션으로 source와 target을 비교합니다.</span></div>
              <button className="button button-secondary" type="button" onClick={() => void runComparison()} disabled={!canRun || comparing || workspace === null || metadataTypesLoading || !scopeValid || !sourceId || !targetOrgId || sourceId === targetOrgId}><Icon name={comparing ? 'refresh' : 'compare'} />{comparing ? '비교 실행 중……' : '현재 type 비교 실행'}</button>
            </div>
          </section>

          <WorkflowStatusPanel
            liveStatus={liveStatus}
            comparisonJob={comparisonJob}
            dryRunJob={dryRunJob}
            deploymentJob={deploymentJob}
          />

          {error && <section className="compare-error" role="alert"><strong>비교 및 배포 작업을 실행하지 못했습니다.</strong><p>{error}</p></section>}
          {comparisonJob !== null && <ComparisonResultPanel
            job={comparisonJob}
            deploymentView
            selectedKeys={new Set(deploymentCart.map((item) => item.key))}
            onSelectionChange={setComponentInCart}
            selectionDisabled={dryRunning || deploying}
          />}
          {dryRunJob !== null && <DryRunResultPanel job={dryRunJob} />}
          {deploymentJob !== null && <DryRunResultPanel job={deploymentJob} />}
        </div>

        <aside className="deploy-summary" aria-label="배포 대상">
          <p className="eyebrow">DEPLOYMENT TARGETS</p><h2>{deploying ? '실제 배포 중' : deploymentJob?.status === 'SUCCEEDED' ? '배포 성공' : dryRunning ? 'Dry-run 실행 중' : dryRunJob?.status === 'APPROVAL_PENDING' ? '배포 승인 준비' : comparing ? '메타데이터 검색 중' : deploymentCart.length > 0 ? `${deploymentCart.length}개 선택됨` : '선택된 배포 대상이 없습니다'}</h2>
          <dl><div><dt>Desired source</dt><dd>{source?.label ?? '선택 대기'}</dd></div><div><dt>Target org</dt><dd>{target?.label ?? '선택 대기'}</dd></div><div><dt>현재 검색</dt><dd>{selectedMetadataType?.name ?? ALL_METADATA_LABEL}</dd></div><div><dt>직접 배포 테스트</dt><dd>{testNames.length > 0 ? `RunSpecifiedTests · ${testNames.length}개 · 75%` : 'NoTestRun'}</dd></div></dl>
          <section className="deployment-cart" aria-label="선택한 배포 목록">
            <div className="deployment-cart-head"><strong>배포 대상</strong><span>{deploymentCart.length}개</span></div>
            {deploymentCart.length === 0
              ? <p>비교 결과에서 metadata를 체크하면 여기에 보존됩니다.</p>
              : <ul>{deploymentCart.map((item) => <li key={item.key}><span><strong>{item.fullName}</strong><small>{item.type}</small></span><button type="button" disabled={dryRunning || deploying} aria-label={`${item.fullName} 배포 대상에서 제거`} onClick={() => setDeploymentCart((current) => current.filter((entry) => entry.key !== item.key))}><Icon name="trash" /></button></li>)}</ul>}
            {deploymentCart.length > 0 && <button className="cart-clear" type="button" disabled={dryRunning || deploying} onClick={() => setDeploymentCart([])}>배포 대상 비우기</button>}
          </section>
          <div className="checksum-preview"><span>PAYLOAD SHA-256</span><code>{dryRunJob?.payloadChecksum ?? deploymentJob?.payloadChecksum ?? '작업 완료 후 계산'}</code></div>
          <div className="warning-note"><Icon name="shield" /><p><strong>TARGET ONLY는 선택할 수 없습니다.</strong>desired source에 실제로 있는 컴포넌트만 배포 대상으로 지정할 수 있습니다.</p></div>
          <div className="cart-actions">
            <button className="button button-primary" type="button" onClick={() => void startDryRun()} disabled={!canRun || dryRunning || deploying || deploymentCart.length === 0 || !testSelectionValid}><Icon name={dryRunning ? 'refresh' : 'shield'} />{dryRunning ? 'Dry-run 중……' : '배포 대상 Dry-run'}<Icon name="arrow" /></button>
          </div>
          <section className="deployment-approval" aria-label="실제 배포 승인">
            <strong>실제 배포 승인</strong>
            <p>{dryRunJob?.status === 'APPROVAL_PENDING'
              ? '성공한 Dry-run의 동일 payload를 배포합니다.'
              : testNames.length > 0
                ? '선택한 테스트를 먼저 검증하고 코드 커버리지 75% 이상일 때만 배포합니다.'
                : '테스트 없이 NoTestRun으로 바로 배포합니다. 프로덕션 org에서는 Salesforce가 거부할 수 있습니다.'} 아래 두 값을 정확히 입력하세요.</p>
            <label><span>대상 org 별칭</span><input value={targetConfirmation} onChange={(event) => setTargetConfirmation(event.target.value)} placeholder={targetAlias} /></label>
            <label><span>확인 문구</span><input value={deploymentConfirmation} onChange={(event) => setDeploymentConfirmation(event.target.value)} placeholder="실제 배포" /></label>
            {!canDeploy && <p className="approval-denied">DEPLOYER 또는 ADMIN 역할만 실제 배포할 수 있습니다.</p>}
            <button className="button button-danger" type="button" onClick={() => void executeDeployment()} disabled={!deploymentReady || dryRunning || deploying}><Icon name={deploying ? 'refresh' : 'deploy'} />{deploying ? '배포 중……' : '배포 대상 실제 배포'}</button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function WorkflowStatusPanel({
  liveStatus,
  comparisonJob,
  dryRunJob,
  deploymentJob,
}: {
  liveStatus: LiveStatus;
  comparisonJob: ComparisonJobResponse | null;
  dryRunJob: DryRunJobResponse | null;
  deploymentJob: DryRunJobResponse | null;
}) {
  const running = [comparisonJob?.status, dryRunJob?.status, deploymentJob?.status]
    .some((status) => status !== undefined && ['QUEUED', 'RUNNING', 'DRY_RUN_RUNNING', 'DEPLOYING'].includes(status));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);
  const connectionLabel = liveStatus === 'connected'
    ? '실시간 연결'
    : liveStatus === 'reconnecting'
      ? '재연결 중'
      : '연결 중';
  const items = [
    workflowStatusItem('비교', comparisonJob, now),
    workflowStatusItem('Dry-run', dryRunJob, now),
    workflowStatusItem('실제 배포', deploymentJob, now),
  ];
  return (
    <section className="workflow-status-panel" aria-labelledby="workflow-status-heading" aria-live="polite">
      <div className="workflow-status-head">
        <div><span className="card-icon icon-blue"><Icon name="activity" /></span><span><h2 id="workflow-status-heading">실행 현황</h2><p>비교부터 배포까지 서버 작업 상태를 실시간으로 표시합니다.</p></span></div>
        <span className={`live-status live-status-${liveStatus}`}><i />{connectionLabel}</span>
      </div>
      <div className="workflow-status-grid">
        {items.map((item) => <article className={`workflow-status-card workflow-status-${item.tone}`} key={item.title} aria-label={`${item.title} 현황`}>
          <span>{item.title}</span>
          <strong>{item.label}</strong>
          <small>{item.detail}</small>
        </article>)}
      </div>
      <p className="workflow-status-note">SSE 연결이 끊기면 자동 재연결하며, polling으로 상태 확인을 계속합니다.</p>
    </section>
  );
}

function workflowStatusItem(
  title: string,
  job: ComparisonJobResponse | DryRunJobResponse | null,
  now: number,
): { title: string; label: string; detail: string; tone: 'idle' | 'pending' | 'success' | 'error' } {
  if (job === null) return { title, label: '대기', detail: '아직 실행되지 않음', tone: 'idle' };
  const status = job.status;
  const seconds = elapsedSeconds(job.startedAt ?? job.createdAt, job.completedAt, now);
  const elapsed = seconds === undefined ? '' : ` · ${seconds}초`;
  const progress = 'progress' in job ? job.progress : undefined;
  const detail = progress === undefined
    ? `Job ${job.id.slice(0, 12)}`
    : progressSummary(progress);
  if (status === 'QUEUED') return { title, label: `대기열${elapsed}`, detail, tone: 'pending' };
  if (['RUNNING', 'DRY_RUN_RUNNING', 'DEPLOYING'].includes(status)) {
    return { title, label: `${progress?.status ?? '진행 중'}${elapsed}`, detail, tone: 'pending' };
  }
  if (status === 'FAILED' || status === 'RECONCILE_REQUIRED') {
    return { title, label: `${status === 'FAILED' ? '실패' : '확인 필요'}${elapsed}`, detail, tone: 'error' };
  }
  return {
    title,
    label: `${status === 'APPROVAL_PENDING' ? '승인 대기' : '완료'}${elapsed}`,
    detail,
    tone: 'success',
  };
}

function elapsedSeconds(startedAt: string | undefined, completedAt: string | undefined, now: number): number | undefined {
  if (startedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = completedAt === undefined ? now : Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1_000)) : undefined;
}

function progressSummary(progress: NonNullable<DryRunJobResponse['progress']>): string {
  const parts = [`SF ${progress.deploymentId}`];
  if (progress.numberComponentsTotal !== undefined) {
    parts.push(`컴포넌트 ${progress.numberComponentsDeployed ?? 0}/${progress.numberComponentsTotal}`);
  }
  if (progress.numberTestsTotal !== undefined) {
    parts.push(`테스트 ${progress.numberTestsCompleted ?? 0}/${progress.numberTestsTotal}`);
  }
  return parts.join(' · ');
}

function RunsPage({ runs, comparisons, deployments }: { runs: DashboardRun[]; comparisons: ComparisonJobResponse[]; deployments: DryRunJobResponse[] }) {
  const succeeded = comparisons.filter((job) => job.status === 'SUCCEEDED').length
    + deployments.filter((job) => ['APPROVAL_PENDING', 'SUCCEEDED'].includes(job.status)).length;
  return (
    <div className="page-stack">
      <PageIntro
        kicker="LOCAL RUNS"
        title="비교와 배포 이력을 다시 확인하세요."
        description="로컬 .sfud/runs에 저장된 리포트와 실패 원인을 한곳에서 확인합니다."
      />
      <section className="run-stats" aria-label="실행 요약">
        <div><span className="card-icon icon-blue"><Icon name="activity" /></span><p>전체 실행<strong>{comparisons.length + deployments.length}</strong></p></div>
        <div><span className="card-icon icon-green"><Icon name="check" /></span><p>성공<strong>{succeeded}</strong></p></div>
        <div><span className="card-icon icon-violet"><Icon name="compare" /></span><p>비교<strong>{comparisons.length}</strong></p></div>
        <div><span className="card-icon icon-blue"><Icon name="deploy" /></span><p>Dry-run<strong>{deployments.filter((job) => job.kind === 'DRY_RUN').length}</strong></p></div>
      </section>
      <section className="history-panel" aria-labelledby="history-heading">
        <div className="history-toolbar">
          <div><h2 id="history-heading">모든 실행</h2><p>최근 실행 순서로 표시합니다.</p></div>
          <div className="filter-row"><button className="filter-active" type="button">전체</button><button type="button">비교</button><button type="button">Dry-run</button><button type="button">실제 배포</button></div>
        </div>
        <div className="runs-list runs-list-flat">{runs.length === 0 ? <p className="empty-runs">아직 저장된 실행이 없습니다.</p> : runs.map((run) => <RunRow key={run.id} {...run} />)}</div>
      </section>
    </div>
  );
}

function SettingsPage({
  user,
  health,
  remoteAccess,
  workspace: initialWorkspace,
}: {
  user: ApiUser;
  health: HealthResponse | null;
  remoteAccess: boolean;
  workspace: WorkspaceResponse | null;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState('');
  const canUpload = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);
  const orgs = workspace?.sources.filter((source) => source.kind === 'org') ?? [];
  const uploadedSources = workspace?.sources.filter((source) => source.location === 'upload') ?? [];

  useEffect(() => {
    setWorkspace(initialWorkspace);
  }, [initialWorkspace]);

  const uploadProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFiles = [...(input.files ?? [])];
    input.value = '';
    if (selectedFiles.length === 0) return;
    const uploadableFiles = selectedFiles.filter((file) => isUploadableProjectFile(
      file.webkitRelativePath || file.name,
    ));
    if (uploadableFiles.length === 0) {
      setUploadMessage('업로드할 수 있는 프로젝트 파일이 없습니다. .git, node_modules와 비밀키 파일은 제외됩니다.');
      return;
    }
    setUploading(true);
    setUploadMessage('');
    try {
      const form = new FormData();
      const firstPath = uploadableFiles[0]!.webkitRelativePath;
      form.append('label', firstPath.length > 0 ? firstPath.split('/')[0]! : '업로드 프로젝트');
      for (const file of uploadableFiles) {
        form.append('files', file, file.webkitRelativePath || file.name);
      }
      const response = await fetch('/api/v1/uploads/projects', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: form,
      });
      const data = await response.json() as { source?: WorkspaceSource; error?: { message: string } };
      if (!response.ok || data.source === undefined) {
        throw new Error(data.error?.message ?? '프로젝트를 업로드하지 못했습니다.');
      }
      setWorkspace((current) => current === null ? current : {
        ...current,
        sources: [...current.sources.filter((entry) => entry.id !== data.source!.id), data.source!],
      });
      const skipped = selectedFiles.length - uploadableFiles.length;
      setUploadMessage(`${data.source.label} 업로드 완료${skipped > 0 ? ` · 제외된 파일 ${skipped}개` : ''}`);
    } catch (caught) {
      setUploadMessage(caught instanceof Error ? caught.message : '프로젝트를 업로드하지 못했습니다.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="page-stack">
      <PageIntro
        kicker="SERVER CONFIGURATION"
        title="연결과 프로젝트 소스를 관리합니다."
        description="Salesforce 인증은 sf CLI에서 관리하고, 내 단말기의 DX 프로젝트는 사용자별 임시 소스로 업로드합니다."
      />
      <div className="settings-grid">
        <section className="workflow-panel" aria-labelledby="server-heading">
          <div className="panel-heading"><span className="card-icon icon-green"><Icon name="activity" /></span><div><h2 id="server-heading">UI 서버</h2><p>현재 Fastify 로컬 서버 상태</p></div><StatusPill label="실행 중" state="online" /></div>
          <dl className="settings-list">
            <div><dt>주소</dt><dd>{health?.host ?? '확인 중'}</dd></div>
            <div><dt>포트</dt><dd>{health?.port ?? '—'}</dd></div>
            <div><dt>버전</dt><dd>v{health?.version ?? '0.1.0'}</dd></div>
            <div><dt>상태 저장소</dt><dd>{health?.storage?.status === 'ok' ? 'SQLite 정상' : '확인 중'}</dd></div>
            <div><dt>배포 큐</dt><dd>{health?.queue?.activeJobId === undefined ? `대기 ${health?.queue?.queuedCount ?? 0}` : '실행 중'}</dd></div>
            <div><dt>비교 큐</dt><dd>{health?.comparisonQueue?.activeJobId === undefined ? `대기 ${health?.comparisonQueue?.queuedCount ?? 0}` : '실행 중'}</dd></div>
            <div><dt>원격 접근</dt><dd className={remoteAccess ? 'warning-text' : ''}>{remoteAccess ? '허용됨' : '차단됨'}</dd></div>
          </dl>
        </section>
        <section className="workflow-panel" aria-labelledby="cli-heading">
          <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="cloud" /></span><div><h2 id="cli-heading">Salesforce CLI</h2><p>CLI 인증 저장소 연결</p></div><StatusPill label="연결됨" state="online" /></div>
          <div className="connection-card"><div className="avatar-stack large"><span>SF</span><i /></div><div><strong>{orgs.length}개 org 사용 가능</strong><p>{orgs.map((org) => org.label).join(' · ') || '연결 확인 중'}</p></div><button type="button" onClick={() => window.location.reload()}><Icon name="refresh" />새로고침</button></div>
        </section>
        <section className="workflow-panel settings-wide" aria-labelledby="project-heading">
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="folder" /></span><div><h2 id="project-heading">명시적으로 등록된 서버 프로젝트</h2><p><code>sfud ui --project &lt;DX 경로&gt;</code>로 등록한 서버의 allowlist</p></div></div>
          {workspace === null
            ? <p className="empty-runs">프로젝트 확인 중입니다.</p>
            : workspace.projects.length === 0
              ? <p className="empty-runs">등록된 서버 프로젝트가 없습니다. 서버 시작 시 <code>--project</code>를 지정하세요.</p>
              : workspace.projects.map((project) => <div className="project-row" key={project.id}><span className="project-logo"><Icon name="code" /></span><div><strong>{project.displayName}</strong><code>Manifest {project.manifests.length}개</code></div><span className="tag tag-green">SERVER</span><span aria-hidden="true"><Icon name="chevron" /></span></div>)}
        </section>
        <section className="workflow-panel settings-wide" aria-labelledby="upload-project-heading">
          <div className="panel-heading">
            <span className="card-icon icon-blue"><Icon name="plus" /></span>
            <div><h2 id="upload-project-heading">내 단말기 프로젝트</h2><p>Salesforce DX 폴더를 현재 사용자만 쓸 수 있는 임시 소스로 업로드합니다.</p></div>
            <label className={`small-button upload-button${uploading ? ' upload-button-busy' : ''}`}>
              <Icon name={uploading ? 'refresh' : 'plus'} />{uploading ? '업로드 중……' : 'DX 프로젝트 업로드'}
              <input
                type="file"
                multiple
                disabled={!canUpload || uploading || workspace === null}
                onChange={(event) => void uploadProject(event)}
                {...{ webkitdirectory: '' }}
              />
            </label>
          </div>
          <div className="upload-policy"><Icon name="shield" /><p><strong>사용자별 임시 저장</strong>마지막 사용 후 4시간 동안 유지하며, <code>.git</code>, <code>node_modules</code>, 비밀키 파일은 업로드에서 제외합니다.</p></div>
          {uploadMessage && <p className="upload-message" role="status">{uploadMessage}</p>}
          {!canUpload && <p className="upload-message">VIEWER 역할은 프로젝트를 업로드할 수 없습니다.</p>}
          {workspace === null
            ? <p className="empty-runs">업로드 프로젝트를 확인 중입니다.</p>
            : uploadedSources.length === 0
              ? <p className="empty-runs">업로드된 프로젝트가 없습니다.</p>
              : <div className="uploaded-project-list">{uploadedSources.map((source) => <div className="project-row" key={source.id}><span className="project-logo project-logo-upload"><Icon name="folder" /></span><div><strong>{source.label}</strong><code>{source.detail}</code></div><span className="tag tag-blue">TEMPORARY</span><a href="/deploy" aria-label={`${source.label} 배포 화면에서 사용`}><Icon name="arrow" /></a></div>)}</div>}
        </section>
      </div>
    </div>
  );
}

function AdminPage({ currentUser }: { currentUser: ApiUser }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/admin/users', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { users?: AdminUser[]; error?: { message: string } };
        if (!response.ok || data.users === undefined) {
          throw new Error(data.error?.message ?? '사용자 목록을 불러오지 못했습니다.');
        }
        setUsers(data.users);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '사용자 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/v1/admin/users', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify({
          displayName: data.get('displayName'),
          email: data.get('email'),
          role: data.get('role'),
          password: data.get('password'),
        }),
      });
      const result = await response.json() as { user?: AdminUser; error?: { message: string } };
      if (!response.ok || result.user === undefined) {
        throw new Error(result.error?.message ?? '사용자를 생성하지 못했습니다.');
      }
      setUsers((current) => [...current, result.user!].sort(compareAdminUsers));
      setMessage(`${result.user.displayName} 계정을 생성했습니다.`);
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '사용자를 생성하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const updateUser = async (userId: string, changes: { role?: ApiUser['role']; disabled?: boolean }) => {
    setSavingIds((current) => new Set(current).add(userId));
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-sfud-csrf': readCookie('sfud_csrf') ?? '' },
        body: JSON.stringify(changes),
      });
      const result = await response.json() as { user?: AdminUser; error?: { message: string } };
      if (!response.ok || result.user === undefined) {
        throw new Error(result.error?.message ?? '사용자 설정을 변경하지 못했습니다.');
      }
      setUsers((current) => current.map((user) => user.id === userId ? result.user! : user).sort(compareAdminUsers));
      setMessage(`${result.user.displayName} 사용자 설정을 변경했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '사용자 설정을 변경하지 못했습니다.');
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
    }
  };

  const activeUsers = users.filter((user) => !user.disabled).length;
  const activeAdmins = users.filter((user) => !user.disabled && user.role === 'ADMIN').length;
  return (
    <div className="page-stack">
      <PageIntro
        kicker="ADMIN ONLY"
        title="사용자와 배포 권한을 관리합니다."
        description="계정을 만들고 역할을 지정하거나 접근을 비활성화합니다. 모든 변경은 감사 로그에 기록됩니다."
      />
      <section className="admin-stats" aria-label="사용자 요약">
        <div><span>전체 사용자</span><strong>{users.length}</strong></div>
        <div><span>활성 사용자</span><strong>{activeUsers}</strong></div>
        <div><span>활성 ADMIN</span><strong>{activeAdmins}</strong></div>
      </section>
      <div className="admin-layout">
        <section className="workflow-panel admin-create-panel" aria-labelledby="admin-create-heading">
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="plus" /></span><div><h2 id="admin-create-heading">사용자 생성</h2><p>초기 로그인 계정과 최소 권한을 지정합니다.</p></div></div>
          <form className="admin-user-form" onSubmit={(event) => void createUser(event)}>
            <label><span>표시 이름</span><input name="displayName" maxLength={80} required placeholder="배포 운영자" /></label>
            <label><span>이메일</span><input name="email" type="email" autoComplete="off" required placeholder="operator@example.com" /></label>
            <label><span>역할</span><select name="role" defaultValue="VIEWER"><option value="VIEWER">VIEWER · 조회 전용</option><option value="OPERATOR">OPERATOR · 비교와 Dry-run</option><option value="DEPLOYER">DEPLOYER · 실제 배포</option><option value="ADMIN">ADMIN · 사용자 관리</option></select></label>
            <label><span>초기 비밀번호</span><input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="12자 이상" /></label>
            <p><Icon name="shield" />비밀번호 원문은 저장하지 않습니다. 생성 후 사용자에게 별도 안전 채널로 전달하세요.</p>
            <button className="button button-primary" type="submit" disabled={submitting}><Icon name={submitting ? 'refresh' : 'plus'} />{submitting ? '생성 중……' : '사용자 생성'}</button>
          </form>
        </section>
        <section className="workflow-panel admin-role-guide" aria-labelledby="role-guide-heading">
          <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="shield" /></span><div><h2 id="role-guide-heading">역할 기준</h2><p>필요한 작업까지만 허용합니다.</p></div></div>
          <dl><div><dt>VIEWER</dt><dd>결과와 실행 이력 조회</dd></div><div><dt>OPERATOR</dt><dd>비교, 업로드, Dry-run</dd></div><div><dt>DEPLOYER</dt><dd>OPERATOR 권한과 실제 배포</dd></div><div><dt>ADMIN</dt><dd>DEPLOYER 권한과 사용자 관리</dd></div></dl>
          <p><Icon name="key" />자기 역할·활성 상태 변경과 마지막 활성 ADMIN 제거는 차단됩니다.</p>
        </section>
      </div>
      {(error || message) && <p className={error ? 'admin-feedback admin-feedback-error' : 'admin-feedback'} role={error ? 'alert' : 'status'}>{error || message}</p>}
      <section className="admin-users-panel" aria-labelledby="admin-users-heading">
        <div className="admin-users-head"><div><h2 id="admin-users-heading">등록 사용자</h2><p>역할 변경은 다음 요청부터 반영되며, 비활성화하면 기존 세션도 종료됩니다.</p></div><span>{users.length}명</span></div>
        {loading
          ? <p className="empty-runs">사용자 목록을 불러오는 중입니다.</p>
          : users.length === 0
            ? <p className="empty-runs">등록된 사용자가 없습니다.</p>
            : <div className="admin-user-list" role="list">{users.map((user) => {
              const isCurrent = user.id === currentUser.id;
              const saving = savingIds.has(user.id);
              return <article className={`admin-user-row${user.disabled ? ' admin-user-disabled' : ''}`} key={user.id} role="listitem">
                <span className="admin-user-avatar"><Icon name="user" /></span>
                <div className="admin-user-identity"><strong>{user.displayName}{isCurrent && <i>나</i>}</strong><span>{user.email}</span><small>등록 {user.createdAt.slice(0, 10)}</small></div>
                <label><span>역할</span><select aria-label={`${user.displayName} 역할`} value={user.role} disabled={saving || isCurrent} onChange={(event) => void updateUser(user.id, { role: event.target.value as ApiUser['role'] })}><option value="VIEWER">VIEWER</option><option value="OPERATOR">OPERATOR</option><option value="DEPLOYER">DEPLOYER</option><option value="ADMIN">ADMIN</option></select></label>
                <span className={`admin-user-state ${user.disabled ? 'admin-user-state-disabled' : ''}`}><i />{user.disabled ? '비활성' : '활성'}</span>
                <button className={user.disabled ? 'admin-user-enable' : 'admin-user-disable'} type="button" disabled={saving || isCurrent} onClick={() => void updateUser(user.id, { disabled: !user.disabled })}>{saving ? '저장 중……' : user.disabled ? '활성화' : '비활성화'}</button>
              </article>;
            })}</div>}
      </section>
    </div>
  );
}

function AdminAccessDenied() {
  return <section className="admin-access-denied" role="alert"><span><Icon name="shield" /></span><h2>ADMIN 권한이 필요합니다.</h2><p>사용자 관리 화면과 API는 ADMIN 계정만 접근할 수 있습니다.</p><a className="button button-secondary" href="/">대시보드로 돌아가기</a></section>;
}

function compareAdminUsers(left: AdminUser, right: AdminUser): number {
  return Number(left.disabled) - Number(right.disabled)
    || left.displayName.localeCompare(right.displayName)
    || left.email.localeCompare(right.email);
}

function PageIntro({ kicker, title, description, children }: { kicker: string; title: string; description: string; children?: ReactNode }) {
  return (
    <header className="page-intro">
      <div><p className="eyebrow text-blue-700">{kicker}</p><h2>{title}</h2><p>{description}</p></div>
      {children}
    </header>
  );
}

function WorkspaceSourceSelect({
  side,
  value,
  sources,
  onChange,
  tone,
}: {
  side: string;
  value: string;
  sources: WorkspaceSource[];
  onChange: (value: string) => void;
  tone: 'blue' | 'violet';
}) {
  const selected = sources.find((source) => source.id === value);
  return (
    <label className={`source-panel source-${tone} source-select`}>
      <span className="source-side">{side}</span>
      <span className="source-logo"><Icon name={selected?.kind === 'local' ? 'folder' : 'cloud'} /></span>
      <span><strong>{selected?.label ?? '소스 조회 중'}</strong><small>{selected?.detail ?? '연결 상태를 확인하고 있습니다.'}</small></span>
      <Icon name="chevron" />
      <select aria-label={`${side} 비교 소스`} value={value} onChange={(event) => onChange(event.target.value)} disabled={sources.length === 0}>
        {sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {source.detail}</option>)}
      </select>
    </label>
  );
}

function ComparisonResultPanel({
  job,
  deploymentView = false,
  selectedKeys = new Set<string>(),
  onSelectionChange,
  selectionDisabled = false,
}: {
  job: ComparisonJobResponse;
  deploymentView?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (component: ComparisonComponent, selected: boolean) => void;
  selectionDisabled?: boolean;
}) {
  const [resultPage, setResultPage] = useState(1);
  useEffect(() => setResultPage(1), [job.id]);
  const displaySource = deploymentView ? job.right : job.left;
  const displayTarget = deploymentView ? job.left : job.right;
  if (job.status === 'QUEUED' || job.status === 'RUNNING') {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? '비교 대기 중' : '메타데이터 비교 중'}</strong><p>{displaySource.label} → {displayTarget.label} · {job.manifest}</p></div></section>;
  }
  if (job.status === 'FAILED') {
    return <section className="compare-error" role="alert"><strong>비교 작업이 실패했습니다.</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
  }
  if (job.result === undefined) return null;
  const summary = job.result.summary;
  const resultPageCount = Math.max(1, Math.ceil(job.result.components.length / METADATA_RESULTS_PER_PAGE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const resultStart = (currentResultPage - 1) * METADATA_RESULTS_PER_PAGE;
  const visibleComponents = job.result.components.slice(resultStart, resultStart + METADATA_RESULTS_PER_PAGE);
  return (
    <section className="comparison-result" aria-labelledby="comparison-result-title">
      <div className="comparison-result-head">
        <div><p className="eyebrow">COMPARISON COMPLETE</p><h2 id="comparison-result-title">{displaySource.label} → {displayTarget.label}</h2><small>{job.manifest}</small></div>
        <span className="result-success"><Icon name="check" />비교 완료</span>
      </div>
      <div className="comparison-summary">
        <div className="summary-added"><span>{deploymentView ? 'NEW' : 'ADDED'}</span><strong>{summary.added}</strong></div>
        <div className="summary-removed"><span>{deploymentView ? 'TARGET ONLY' : 'REMOVED'}</span><strong>{summary.removed}</strong></div>
        <div className="summary-modified"><span>MODIFIED</span><strong>{summary.modified}</strong></div>
        <div><span>IDENTICAL</span><strong>{summary.identical}</strong></div>
      </div>
      {job.result.warnings.map((warning) => <p className="comparison-warning" key={warning}><Icon name="shield" />{warning}</p>)}
      {deploymentView && summary.removed > 0 && <p className="comparison-warning"><Icon name="shield" />TARGET ONLY 항목은 destructive manifest 없이는 target org에서 삭제되지 않습니다.</p>}
      <div className="component-results">
        {job.result.components.length === 0
          ? <p className="empty-result">표시할 차이가 없습니다. 두 소스가 동일합니다.</p>
          : visibleComponents.map((component) => <details key={component.key} className={`component-result${deploymentView ? ' component-selectable' : ''}${selectedKeys.has(component.key) ? ' component-selected' : ''}`}>
              <summary>{deploymentView && <label className={`component-cart-check${component.status === 'REMOVED' || selectionDisabled ? ' component-cart-disabled' : ''}`} onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`${component.fullName} 배포 대상으로 선택`}
                  checked={selectedKeys.has(component.key)}
                  disabled={component.status === 'REMOVED' || selectionDisabled}
                  onChange={(event) => onSelectionChange?.(component, event.target.checked)}
                />
                <span aria-hidden="true"><Icon name="check" /></span>
              </label>}<span className={`component-status status-${component.status.toLowerCase()}`}>{deploymentView ? deploymentDiffStatusLabel(component.status) : component.status}</span><div><strong>{component.fullName}</strong><small>{component.type} · 파일 {component.files.length}개{deploymentView && component.status === 'REMOVED' ? ' · 소스에 없어 선택 불가' : ''}</small></div><Icon name="chevron" /></summary>
              <div className="component-files">{component.files.map((file) => <article key={file.path}><div><code>{file.path}</code><span>{file.status}</span></div>{file.xmlChanges !== undefined && file.xmlChanges.length > 0 && <p>XML 변경 {file.xmlChanges.length}개</p>}{file.unifiedDiff && <pre>{file.unifiedDiff}</pre>}</article>)}</div>
            </details>)}
        {job.result.components.length > METADATA_RESULTS_PER_PAGE && <nav className="component-pagination" aria-label="메타데이터 검색 결과 페이지">
          <button type="button" onClick={() => setResultPage((page) => Math.max(1, page - 1))} disabled={currentResultPage === 1} aria-label="이전 페이지"><Icon name="chevron" />이전</button>
          <span><strong>{currentResultPage}</strong> / {resultPageCount}페이지 · {resultStart + 1}-{Math.min(resultStart + METADATA_RESULTS_PER_PAGE, job.result.components.length)} / {job.result.components.length}개</span>
          <button type="button" onClick={() => setResultPage((page) => Math.min(resultPageCount, page + 1))} disabled={currentResultPage === resultPageCount} aria-label="다음 페이지">다음<Icon name="chevron" /></button>
        </nav>}
      </div>
    </section>
  );
}

function DryRunResultPanel({ job }: { job: DryRunJobResponse }) {
  if (job.kind === 'DEPLOY' && ['QUEUED', 'DEPLOYING'].includes(job.status)) {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? '실제 배포 대기 중' : `Salesforce 실제 배포 중${job.progress === undefined ? '' : ` · ${job.progress.status}`}`}</strong><p>{job.progress === undefined ? `${job.source.label} → ${job.target.label} · dry-run으로 고정한 payload를 배포합니다.` : progressSummary(job.progress)}</p></div></section>;
  }
  if (['QUEUED', 'DRY_RUN_RUNNING'].includes(job.status)) {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? 'dry-run 대기 중' : `Salesforce check-only 실행 중${job.progress === undefined ? '' : ` · ${job.progress.status}`}`}</strong><p>{job.progress === undefined ? `${job.source.label} → ${job.target.label} · snapshot, 차이, 테스트를 검증합니다.` : progressSummary(job.progress)}</p></div></section>;
  }
  if (job.status === 'FAILED' || job.status === 'RECONCILE_REQUIRED') {
    return <section className="compare-error" role="alert"><strong>{job.status === 'FAILED' ? `${job.kind === 'DEPLOY' ? '실제 배포' : 'dry-run'}이 실패했습니다.` : 'Salesforce 상태 재확인이 필요합니다.'}</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
  }
  if (job.kind === 'DEPLOY' && job.status === 'SUCCEEDED') {
    return <section className="dry-run-result" aria-label="Salesforce 실제 배포 성공"><div className="comparison-result-head"><div><p className="eyebrow">DEPLOYMENT COMPLETE</p><h2>Salesforce 실제 배포 성공</h2><small>{job.salesforceDeploymentId ?? 'deployment ID 없음'}</small></div><span className="result-success"><Icon name="check" />배포 성공</span></div><div className="approval-preview"><Icon name="shield" /><div><strong>선택한 payload 배포를 완료했습니다.</strong><p>{job.testPlan?.tests.length
      ? `${job.testPlan.tests.join(', ')} · 코드 커버리지 ${job.testCoverage?.toFixed(2) ?? '확인 완료'}%`
      : 'NoTestRun · 테스트 없이 target org에 반영했습니다.'}</p></div></div></section>;
  }
  if (job.status !== 'APPROVAL_PENDING') return null;
  const summary = job.comparisonSummary;
  return (
    <section className="dry-run-result" aria-labelledby="dry-run-result-title">
      <div className="comparison-result-head"><div><p className="eyebrow">CHECK-ONLY COMPLETE</p><h2 id="dry-run-result-title">Salesforce dry-run 성공</h2><small>{job.salesforceDeploymentId ?? 'deployment ID 없음'}</small></div><span className="result-success"><Icon name="check" />검증 성공</span></div>
      {summary !== undefined && <div className="comparison-summary"><div className="summary-added"><span>NEW</span><strong>{summary.added}</strong></div><div className="summary-removed"><span>TARGET ONLY</span><strong>{summary.removed}</strong></div><div className="summary-modified"><span>MODIFIED</span><strong>{summary.modified}</strong></div><div><span>TOTAL</span><strong>{summary.total}</strong></div></div>}
      <div className="dry-run-details">
        <div><span className="card-icon icon-green"><Icon name="check" /></span><p><strong>{job.testPlan?.level ?? '테스트 수준 미상'}</strong>{job.testPlan?.tests.length ? `${job.testPlan.tests.join(', ')}${job.testCoverage === undefined ? '' : ` · ${job.testCoverage.toFixed(2)}%`}` : 'Salesforce 구성 테스트'}</p></div>
        <div><span className="card-icon icon-blue"><Icon name="shield" /></span><p><strong>Payload 고정</strong><code>{job.payloadChecksum}</code></p></div>
      </div>
      <div className="approval-preview"><Icon name="shield" /><div><strong>실제 배포 승인 준비가 완료되었습니다.</strong><p>오른쪽 배포 대상에서 동일 payload checksum과 대상 org를 다시 확인한 뒤 배포할 수 있습니다.</p></div></div>
    </section>
  );
}

function deploymentDiffStatusLabel(status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL'): string {
  if (status === 'ADDED') return 'NEW';
  if (status === 'REMOVED') return 'TARGET ONLY';
  return status;
}

function OptionToggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="option-toggle">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" />
    </label>
  );
}

function StatusPill({ label, state }: { label: string; state: 'online' | 'pending' | 'error' }) {
  return <span className={`status-pill status-${state}`}><i />{label}</span>;
}

function EnvironmentBadge({ label, subtitle, initials }: { label: string; subtitle: string; initials: string }) {
  return (
    <div className="environment">
      <span className="environment-logo"><Icon name="cloud" /><small>{initials}</small></span>
      <strong>{label}</strong>
      <small>{subtitle}</small>
    </div>
  );
}

interface OverviewCardProps {
  icon: IconName;
  title: string;
  value: string;
  detail: string;
  action: string;
  tone: 'blue' | 'violet' | 'green';
  children: ReactNode;
}

function OverviewCard({ icon, title, value, detail, action, tone, children }: OverviewCardProps) {
  return (
    <article className="overview-card">
      <div className="card-title"><span className={`card-icon icon-${tone}`}><Icon name={icon} /></span><h3>{title}</h3></div>
      <div className="card-value"><strong>{value}</strong><span>{detail}</span></div>
      <div className="card-meta">{children}</div>
      <button className="card-action" type="button">{action}<Icon name="arrow" /></button>
    </article>
  );
}

function RunRow(run: DashboardRun) {
  return (
    <article className="run-row">
      <div className={`run-kind run-${run.tone}`}><Icon name={run.kind === '비교' ? 'compare' : 'deploy'} /></div>
      <div className="run-main">
        <div className="run-title"><span className={`tag tag-${run.tone}`}>{run.kind}</span><strong>{run.source}</strong><Icon name="arrow" /><strong>{run.target}</strong></div>
        <p>{run.summary}</p>
      </div>
      <time><Icon name="clock" />{run.time}</time>
      <button type="button" aria-label={`${run.source} 실행 결과 보기`}><Icon name="chevron" /></button>
    </article>
  );
}

function toDashboardRun(job: ComparisonJobResponse): DashboardRun {
  const summary = job.summary;
  return {
    id: job.id,
    kind: '비교',
    source: job.left.label,
    target: job.right.label,
    summary: summary === undefined
      ? comparisonStatusLabel(job.status)
      : `추가 ${summary.added} · 삭제 ${summary.removed} · 변경 ${summary.modified}`,
    time: formatRunTime(job.createdAt),
    tone: job.status === 'SUCCEEDED' ? 'green' : job.status === 'FAILED' ? 'amber' : 'blue',
    createdAt: job.createdAt ?? '',
  };
}

function toDashboardDryRun(job: DryRunJobResponse): DashboardRun {
  const summary = job.comparisonSummary;
  return {
    id: job.id,
    kind: job.kind === 'DRY_RUN' ? 'DRY-RUN' : '배포',
    source: job.source.label,
    target: job.target.label,
    summary: summary === undefined
      ? deploymentStatusLabel(job.status)
      : `NEW ${summary.added} · TARGET ONLY ${summary.removed} · 변경 ${summary.modified}`,
    time: formatRunTime(job.createdAt),
    tone: ['APPROVAL_PENDING', 'SUCCEEDED'].includes(job.status)
      ? 'green'
      : ['FAILED', 'RECONCILE_REQUIRED'].includes(job.status) ? 'amber' : 'blue',
    createdAt: job.createdAt,
  };
}

function comparisonStatusLabel(status: ComparisonJobResponse['status']): string {
  return ({ QUEUED: '대기', RUNNING: '실행 중', SUCCEEDED: '성공', FAILED: '실패' })[status];
}

function deploymentStatusLabel(status: DryRunJobResponse['status']): string {
  return ({
    QUEUED: '대기', DRY_RUN_RUNNING: 'dry-run 실행 중', APPROVAL_PENDING: 'dry-run 성공',
    DEPLOYING: '배포 중', SUCCEEDED: '배포 성공', FAILED: '실패', RECONCILE_REQUIRED: '재확인 필요',
  })[status];
}

function formatRunTime(value: string | undefined): string {
  if (value === undefined) return '시간 미상';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시간 미상';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function AuthLoading({ failed }: { failed: boolean }) {
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-live="polite">
        <img src="/favicon.svg" alt="" />
        <p className="eyebrow">SFUD ACCESS</p>
        <h1>{failed ? '인증 서버에 연결할 수 없습니다.' : '보안 상태를 확인하고 있습니다……'}</h1>
        {failed && <button className="button button-primary" type="button" onClick={() => window.location.reload()}>다시 시도</button>}
      </section>
    </main>
  );
}

function AuthScreen({
  setupRequired,
  onAuthenticated,
}: {
  setupRequired: boolean;
  onAuthenticated: (user: ApiUser) => void;
}) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const body = setupRequired
      ? {
          bootstrapToken: form.get('bootstrapToken'),
          email: form.get('email'),
          displayName: form.get('displayName'),
          password: form.get('password'),
        }
      : { email: form.get('email'), password: form.get('password') };
    try {
      const response = await fetch(setupRequired ? '/api/v1/auth/bootstrap' : '/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { user?: ApiUser; error?: { message: string } };
      if (!response.ok || result.user === undefined) {
        throw new Error(result.error?.message ?? '인증하지 못했습니다.');
      }
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '인증하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-backdrop"><i /><i /></div>
      <section className="auth-card">
        <div className="auth-brand"><img src="/favicon.svg" alt="" /><span><strong>sfud</strong><small>Deployment Console</small></span></div>
        <span className="auth-icon"><Icon name={setupRequired ? 'key' : 'shield'} /></span>
        <p className="eyebrow">{setupRequired ? 'FIRST ADMIN' : 'SECURE ACCESS'}</p>
        <h1>{setupRequired ? '최초 관리자를 설정합니다.' : '다시 오셨군요.'}</h1>
        <p>{setupRequired
          ? '서버 시작 로그에 표시된 일회용 설정 코드와 관리자 정보를 입력하세요.'
          : '배포 콘솔에 접근하려면 관리자에게 등록된 계정으로 로그인하세요.'}</p>
        <form onSubmit={(event) => void submit(event)}>
          {setupRequired && <>
            <label htmlFor="bootstrap-token">초기 설정 코드</label>
            <input id="bootstrap-token" name="bootstrapToken" autoComplete="off" required />
            <label htmlFor="display-name">표시 이름</label>
            <input id="display-name" name="displayName" autoComplete="name" maxLength={80} required />
          </>}
          <label htmlFor="auth-email">이메일</label>
          <input id="auth-email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="auth-password">비밀번호</label>
          <input id="auth-password" name="password" type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required />
          {setupRequired && <small className="auth-hint">12자 이상 128자 이하로 입력하세요.</small>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary" type="submit" disabled={submitting}>
            <Icon name={setupRequired ? 'key' : 'shield'} />{submitting ? '확인 중……' : setupRequired ? '관리자 생성' : '로그인'}
          </button>
        </form>
        <div className="auth-security"><Icon name="shield" />세션 원문과 비밀번호는 데이터베이스에 저장하지 않습니다.</div>
      </section>
    </main>
  );
}

function readCookie(name: string): string | undefined {
  for (const cookie of document.cookie.split(';')) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function isUploadableProjectFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => ['.git', '.sf', '.sfdx', 'node_modules'].includes(segment))) return false;
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  return basename !== '.env'
    && !basename.startsWith('.env.')
    && !['.key', '.pem', '.p12', '.pfx'].some((extension) => basename.endsWith(extension));
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    activity: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    check: <><path d="m5 12 4 4L19 6" /></>,
    chevron: <><path d="m9 18 6-6-6-6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    cloud: <><path d="M17.5 19H6a4 4 0 0 1-.4-8A6.5 6.5 0 0 1 18 9.2a5 5 0 0 1-.5 9.8Z" /></>,
    code: <><path d="m9 18-6-6 6-6M15 6l6 6-6 6" /></>,
    compare: <><path d="M7 7h11m0 0-3-3m3 3-3 3M17 17H6m0 0 3 3m-3-3 3-3" /></>,
    deploy: <><path d="m12 3 4 4-4 4-4-4 4-4ZM5 13l4 4-4 4-4-4 4-4ZM19 13l4 4-4 4-4-4 4-4Z" /><path d="M12 11v3m-3 3h6" /></>,
    folder: <><path d="M3 6.5h7l2 2h9v10.5H3V6.5Z" /></>,
    history: <><path d="M4 12a8 8 0 1 0 2-5.3L4 9" /><path d="M4 4v5h5M12 8v5l3 2" /></>,
    home: <><path d="m3 11 9-8 9 8v10h-6v-6H9v6H3V11Z" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 3 3m-6 0 2 2" /></>,
    logout: <><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M18.2 9A7 7 0 0 0 6 6.5L4 9m2 6a7 7 0 0 0 12 2.5L20 15" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.8 7.5 9.5 4.3-1.7 7.5-4.9 7.5-9.5V6L12 3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
