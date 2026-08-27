import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

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

interface WorkspaceSource {
  id: string;
  kind: 'org' | 'local';
  label: string;
  detail: string;
}

interface WorkspaceProject {
  id: string;
  displayName: string;
  manifests: string[];
}

interface WorkspaceResponse {
  sources: WorkspaceSource[];
  projects: WorkspaceProject[];
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
  summary?: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
  result?: {
    summary: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
    warnings: string[];
    components: Array<{
      key: string;
      type: string;
      fullName: string;
      status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL';
      files: Array<{ path: string; status: string; unifiedDiff?: string; xmlChanges?: Array<{ path: string; before?: string; after?: string }> }>;
    }>;
  };
}

interface DryRunJobResponse {
  id: string;
  kind: 'DRY_RUN' | 'DEPLOY';
  status: 'QUEUED' | 'DRY_RUN_RUNNING' | 'APPROVAL_PENDING' | 'DEPLOYING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  source: { id: string; kind: 'org' | 'local'; label: string };
  target: { id: string; kind: 'org'; label: string };
  manifest: string;
  scope?: 'all' | 'manifest';
  metadataType?: string;
  prepared: boolean;
  payloadChecksum?: string;
  salesforceDeploymentId?: string;
  testPlan?: { level: string; tests: string[]; selection: string };
  comparisonSummary?: { added: number; removed: number; modified: number; identical: number; total: number; different: number };
  comparison?: ComparisonJobResponse['result'];
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

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

type PageKey = 'home' | 'deploy' | 'runs' | 'settings';

const ALL_METADATA_LABEL = '전체 메타데이터';

const pageMeta: Record<PageKey, { eyebrow: string; title: string }> = {
  home: { eyebrow: 'METADATA WORKSPACE', title: '배포 대시보드' },
  deploy: { eyebrow: 'COMPARE & DEPLOY', title: '비교 및 배포' },
  runs: { eyebrow: 'RUN HISTORY', title: '실행 기록' },
  settings: { eyebrow: 'LOCAL CONFIGURATION', title: '설정' },
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
          {navigation.map((item) => (
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
              title="로컬 DX 프로젝트"
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
          {currentPage === 'settings' && <SettingsPage health={health} remoteAccess={remoteAccess} workspace={dashboardWorkspace} />}
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
  const [strict, setStrict] = useState(false);
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
          strict,
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
          <div><h2 id="options-heading">비교 옵션</h2><p>리포트에 표시할 차이 수준을 선택합니다.</p></div>
        </div>
        <div className="option-grid">
          <OptionToggle title="Strict 비교" description="XML 원문 형식 차이까지 탐지" checked={strict} onChange={setStrict} />
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
  const [strict, setStrict] = useState(false);
  const [showIdentical, setShowIdentical] = useState(false);
  const [comparisonJob, setComparisonJob] = useState<ComparisonJobResponse | null>(null);
  const [dryRunJob, setDryRunJob] = useState<DryRunJobResponse | null>(null);
  const [error, setError] = useState('');
  const comparisonRequestControllerRef = useRef<AbortController | null>(null);
  const dryRunRequestControllerRef = useRef<AbortController | null>(null);
  const comparisonJobSelectionKeyRef = useRef<string | null>(null);
  const dryRunJobSelectionKeyRef = useRef<string | null>(null);
  const workflowSelectionKey = [sourceId, targetOrgId, scopeQuery, strict, showIdentical].join('\u0000');
  const dryRunSelectionKey = [workflowSelectionKey, testLevel, tests].join('\u0000');
  const workflowSelectionKeyRef = useRef(workflowSelectionKey);
  const dryRunSelectionKeyRef = useRef(dryRunSelectionKey);
  workflowSelectionKeyRef.current = workflowSelectionKey;
  dryRunSelectionKeyRef.current = dryRunSelectionKey;
  const canRun = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);

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
    dryRunRequestControllerRef.current?.abort();
    comparisonJobSelectionKeyRef.current = null;
    dryRunJobSelectionKeyRef.current = null;
    setComparisonJob(null);
    setDryRunJob(null);
  }, [sourceId, targetOrgId, scopeQuery, strict, showIdentical]);

  useEffect(() => {
    dryRunRequestControllerRef.current?.abort();
    dryRunJobSelectionKeyRef.current = null;
    setDryRunJob(null);
  }, [testLevel, tests]);

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

  const source = workspace?.sources.find((entry) => entry.id === sourceId);
  const target = workspace?.sources.find((entry) => entry.id === targetOrgId);
  const comparing = comparisonJob !== null && ['QUEUED', 'RUNNING'].includes(comparisonJob.status);
  const dryRunning = dryRunJob !== null && ['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status);
  const testNames = tests.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
  const selectedMetadataType = metadataTypes.find((entry) =>
    entry.name.toLowerCase() === scopeQuery.trim().toLowerCase());
  const scopeValid = scopeQuery === ALL_METADATA_LABEL || selectedMetadataType !== undefined;
  const comparisonReady = comparisonJob?.status === 'SUCCEEDED';

  const runComparison = async () => {
    setError('');
    setComparisonJob(null);
    setDryRunJob(null);
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
          strict,
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
    setError('');
    setDryRunJob(null);
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
          scope: 'all',
          ...(selectedMetadataType === undefined ? {} : { metadataType: selectedMetadataType.name }),
          sourceId, targetOrgId, testLevel, tests: testNames, waitMinutes: 60, strict,
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

  return (
    <div className="page-stack">
      <PageIntro kicker="COMPARE, THEN DRY-RUN" title="한 흐름에서 비교하고 배포를 검증합니다." description="desired source와 target org의 전체 배포 가능 metadata를 비교한 뒤 같은 범위로 Salesforce check-only를 실행합니다.">
        <div className="stepper" aria-label="배포 단계"><span className="step-active"><i>1</i>범위 선택</span><b /><span className={comparisonReady ? 'step-active' : ''}><i>2</i>차이 확인</span><b /><span className={dryRunJob !== null ? 'step-active' : ''}><i>3</i>Dry-run</span><b /><span><i>4</i>배포 승인</span></div>
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
            <div className="panel-heading"><span className="step-number">02</span><div><h2 id="deploy-scope-heading">비교 및 배포 범위</h2><p>Salesforce 전체 metadata type에서 검색하고, 비교와 Dry-run에 같은 범위를 사용합니다.</p></div><span className="panel-state">필수</span></div>
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
            <div className="panel-heading"><span className="step-number">03</span><div><h2 id="test-heading">비교 옵션과 Apex 테스트</h2><p>비교가 완료되면 선택한 테스트 조건으로 Dry-run을 실행할 수 있습니다.</p></div><span className="auto-badge">{testLevel.toUpperCase()}</span></div>
            <div className="select-row">
              <label><span>테스트 수준</span><select value={testLevel} onChange={(event) => setTestLevel(event.target.value)}><option value="auto">Auto · 권장</option><option value="RunSpecifiedTests">RunSpecifiedTests</option><option value="RunLocalTests">RunLocalTests</option><option value="RunAllTestsInOrg">RunAllTestsInOrg</option><option value="RunRelevantTests">RunRelevantTests</option><option value="NoTestRun">NoTestRun</option></select></label>
              <label><span>테스트 클래스</span><input className="tests-input" value={tests} onChange={(event) => setTests(event.target.value)} placeholder="AccountService_Test, Other_Test" disabled={!['auto', 'RunSpecifiedTests'].includes(testLevel)} /></label>
            </div>
            <div className="option-grid">
              <OptionToggle title="Strict 비교" description="XML 원문 형식 차이까지 탐지" checked={strict} onChange={setStrict} />
              <OptionToggle title="동일 항목 표시" description="IDENTICAL 컴포넌트도 결과에 포함" checked={showIdentical} onChange={setShowIdentical} />
            </div>
          </section>

          {error && <section className="compare-error" role="alert"><strong>비교 및 배포 작업을 실행하지 못했습니다.</strong><p>{error}</p></section>}
          {comparisonJob !== null && <ComparisonResultPanel job={comparisonJob} deploymentView />}
          {dryRunJob !== null && <DryRunResultPanel job={dryRunJob} />}
        </div>

        <aside className="deploy-summary" aria-label="비교 및 Dry-run 요약">
          <p className="eyebrow">DEPLOYMENT WORKFLOW</p><h2>{dryRunning ? 'Dry-run 실행 중' : dryRunJob?.status === 'APPROVAL_PENDING' ? '검증 성공' : comparing ? '비교 실행 중' : comparisonReady ? 'Dry-run 준비' : '비교 준비'}</h2>
          <dl><div><dt>Desired source</dt><dd>{source?.label ?? '선택 대기'}</dd></div><div><dt>Target org</dt><dd>{target?.label ?? '선택 대기'}</dd></div><div><dt>Metadata scope</dt><dd>{selectedMetadataType?.name ?? ALL_METADATA_LABEL}</dd></div><div><dt>Test level</dt><dd>{testLevel}</dd></div></dl>
          <div className="checksum-preview"><span>PAYLOAD SHA-256</span><code>{dryRunJob?.payloadChecksum ?? 'dry-run 완료 후 계산'}</code></div>
          <div className="warning-note"><Icon name="shield" /><p><strong>실제 배포가 아닙니다.</strong>이번 요청에는 항상 Salesforce `--dry-run`이 적용됩니다.</p></div>
          {!comparisonReady
            ? <button className="button button-primary" type="button" onClick={() => void runComparison()} disabled={!canRun || comparing || workspace === null || metadataTypesLoading || !scopeValid || !sourceId || !targetOrgId || sourceId === targetOrgId}><Icon name={comparing ? 'refresh' : 'compare'} />{comparing ? '비교 중……' : '비교 실행'}<Icon name="arrow" /></button>
            : <button className="button button-primary" type="button" onClick={() => void startDryRun()} disabled={!canRun || dryRunning}><Icon name={dryRunning ? 'refresh' : 'deploy'} />{dryRunning ? '검증 중……' : '같은 범위로 Dry-run'}<Icon name="arrow" /></button>}
        </aside>
      </div>
    </div>
  );
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

function SettingsPage({ health, remoteAccess, workspace }: { health: HealthResponse | null; remoteAccess: boolean; workspace: WorkspaceResponse | null }) {
  const orgs = workspace?.sources.filter((source) => source.kind === 'org') ?? [];
  return (
    <div className="page-stack">
      <PageIntro
        kicker="LOCAL ONLY"
        title="연결과 로컬 프로젝트를 관리합니다."
        description="Salesforce 인증은 sf CLI에서 관리하며 access token과 auth URL은 UI에 저장하지 않습니다."
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
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="folder" /></span><div><h2 id="project-heading">허용된 로컬 프로젝트</h2><p>브라우저에서 접근 가능한 DX 프로젝트 allowlist</p></div><button className="small-button" type="button"><Icon name="plus" />프로젝트 추가</button></div>
          {workspace?.projects.map((project) => <div className="project-row" key={project.id}><span className="project-logo"><Icon name="code" /></span><div><strong>{project.displayName}</strong><code>Manifest {project.manifests.length}개</code></div><span className="tag tag-green">ACTIVE</span><button type="button" aria-label={`${project.displayName} 프로젝트 설정`}><Icon name="chevron" /></button></div>) ?? <p className="empty-runs">프로젝트 확인 중입니다.</p>}
        </section>
      </div>
    </div>
  );
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

function ComparisonResultPanel({ job, deploymentView = false }: { job: ComparisonJobResponse; deploymentView?: boolean }) {
  if (job.status === 'QUEUED' || job.status === 'RUNNING') {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? '비교 대기 중' : '메타데이터 비교 중'}</strong><p>{job.left.label} → {job.right.label} · {job.manifest}</p></div></section>;
  }
  if (job.status === 'FAILED') {
    return <section className="compare-error" role="alert"><strong>비교 작업이 실패했습니다.</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
  }
  if (job.result === undefined) return null;
  const summary = job.result.summary;
  return (
    <section className="comparison-result" aria-labelledby="comparison-result-title">
      <div className="comparison-result-head">
        <div><p className="eyebrow">COMPARISON COMPLETE</p><h2 id="comparison-result-title">{job.left.label} → {job.right.label}</h2><small>{job.manifest}</small></div>
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
          : job.result.components.map((component) => <details key={component.key} className="component-result">
              <summary><span className={`component-status status-${component.status.toLowerCase()}`}>{deploymentView ? deploymentDiffStatusLabel(component.status) : component.status}</span><div><strong>{component.fullName}</strong><small>{component.type} · 파일 {component.files.length}개</small></div><Icon name="chevron" /></summary>
              <div className="component-files">{component.files.map((file) => <article key={file.path}><div><code>{file.path}</code><span>{file.status}</span></div>{file.xmlChanges !== undefined && file.xmlChanges.length > 0 && <p>XML 변경 {file.xmlChanges.length}개</p>}{file.unifiedDiff && <pre>{file.unifiedDiff}</pre>}</article>)}</div>
            </details>)}
      </div>
    </section>
  );
}

function DryRunResultPanel({ job }: { job: DryRunJobResponse }) {
  if (['QUEUED', 'DRY_RUN_RUNNING'].includes(job.status)) {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? 'dry-run 대기 중' : 'Salesforce check-only 실행 중'}</strong><p>{job.source.label} → {job.target.label} · snapshot, 차이, 테스트를 검증합니다.</p></div></section>;
  }
  if (job.status === 'FAILED' || job.status === 'RECONCILE_REQUIRED') {
    return <section className="compare-error" role="alert"><strong>{job.status === 'FAILED' ? 'dry-run이 실패했습니다.' : 'Salesforce 상태 재확인이 필요합니다.'}</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
  }
  if (job.status !== 'APPROVAL_PENDING') return null;
  const summary = job.comparisonSummary;
  return (
    <section className="dry-run-result" aria-labelledby="dry-run-result-title">
      <div className="comparison-result-head"><div><p className="eyebrow">CHECK-ONLY COMPLETE</p><h2 id="dry-run-result-title">Salesforce dry-run 성공</h2><small>{job.salesforceDeploymentId ?? 'deployment ID 없음'}</small></div><span className="result-success"><Icon name="check" />검증 성공</span></div>
      {summary !== undefined && <div className="comparison-summary"><div className="summary-added"><span>NEW</span><strong>{summary.added}</strong></div><div className="summary-removed"><span>TARGET ONLY</span><strong>{summary.removed}</strong></div><div className="summary-modified"><span>MODIFIED</span><strong>{summary.modified}</strong></div><div><span>TOTAL</span><strong>{summary.total}</strong></div></div>}
      <div className="dry-run-details">
        <div><span className="card-icon icon-green"><Icon name="check" /></span><p><strong>{job.testPlan?.level ?? '테스트 수준 미상'}</strong>{job.testPlan?.tests.length ? job.testPlan.tests.join(', ') : 'Salesforce 구성 테스트'}</p></div>
        <div><span className="card-icon icon-blue"><Icon name="shield" /></span><p><strong>Payload 고정</strong><code>{job.payloadChecksum}</code></p></div>
      </div>
      <div className="approval-preview"><Icon name="shield" /><div><strong>실제 배포는 아직 잠겨 있습니다.</strong><p>다음 단계에서 동일 payload checksum과 대상 org를 다시 확인하고 권한 있는 사용자만 승인할 수 있습니다.</p></div><button className="button button-secondary" type="button" disabled>배포 승인 준비</button></div>
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
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
