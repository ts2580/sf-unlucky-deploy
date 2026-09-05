import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';

import type { DeploymentJobResponse } from '../../src/api/deployment-contracts';
import type {
  DiagnosticsResponse,
  HealthResponse as PublicHealthResponse,
} from '../../src/web/shared/api';
import { AdminAccessDenied, AdminPage } from './admin/AdminPage';
import { apiRequest } from './api-client';
import {
  getAuthStatus,
  logout as logoutSession,
  type ApiUser,
  type AuthStatusResponse,
} from './auth/api';
import { AuthLoading, AuthScreen } from './auth/AuthPage';
import { listComparisonJobs, type ComparisonJobResponse } from './comparison/api';
import { listDeploymentJobs } from './deployment/api';
import { DeploymentPage } from './deployment/DeploymentPage';
import { Icon, type IconName } from './components/Icon';
import { PageIntro } from './components/PageIntro';

type HealthResponse = PublicHealthResponse
  & Partial<Omit<DiagnosticsResponse, keyof PublicHealthResponse>>;

interface WorkspaceSource {
  id: string;
  kind: 'org' | 'local';
  location?: 'org' | 'server' | 'upload';
  label: string;
  detail: string;
  username?: string;
  maskedOrgId?: string;
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

interface UserSettings {
  testClassSuffix: string;
}

type DryRunJobResponse = DeploymentJobResponse;

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
  const remoteAccess = health?.host !== undefined
    && !['127.0.0.1', 'localhost', '::1'].includes(health.host);

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<HealthResponse>('/api/v1/health', { signal: controller.signal })
      .then(setHealth)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHealthFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (auth?.authenticated !== true) return;
    const controller = new AbortController();
    apiRequest<HealthResponse>('/api/v1/diagnostics', { signal: controller.signal })
      .then((diagnostics) => {
        setHealth((current) => ({ ...current, ...diagnostics }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      });
    return () => controller.abort();
  }, [auth?.authenticated]);

  useEffect(() => {
    const controller = new AbortController();
    getAuthStatus(controller.signal)
      .then(setAuth)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setAuthFailed(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => setAuth({ setupRequired: false, authenticated: false });
    window.addEventListener('sfud:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('sfud:unauthorized', handleUnauthorized);
  }, []);

  useEffect(() => {
    document.title = `${currentMeta.title} · sfud`;
  }, [currentMeta.title]);

  useEffect(() => {
    if (auth?.authenticated !== true) return;
    const controller = new AbortController();
    void Promise.all([
      apiRequest<WorkspaceResponse>('/api/v1/workspace', { signal: controller.signal })
        .then(setDashboardWorkspace),
      listComparisonJobs(controller.signal)
        .then((response) => setRecentComparisons(response.jobs)),
      listDeploymentJobs(controller.signal)
        .then((response) => setRecentDeployments(response.jobs)),
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
    await logoutSession();
    setAuth({ setupRequired: false, authenticated: false });
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
          {currentPage === 'deploy' && <DeploymentPage user={auth.user} />}
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

function RunsPage({ runs, comparisons, deployments }: { runs: DashboardRun[]; comparisons: ComparisonJobResponse[]; deployments: DryRunJobResponse[] }) {
  const succeeded = comparisons.filter((job) => job.status === 'SUCCEEDED').length
    + deployments.filter((job) => ['APPROVAL_PENDING', 'SUCCEEDED'].includes(job.status)).length;
  return (
    <div className="page-stack">
      <PageIntro
        kicker="LOCAL RUNS"
        title="비교와 배포 이력을 다시 확인하세요."
      />
      <section className="run-stats" aria-label="실행 요약">
        <div><span className="card-icon icon-blue"><Icon name="activity" /></span><p>전체 실행<strong>{comparisons.length + deployments.length}</strong></p></div>
        <div><span className="card-icon icon-green"><Icon name="check" /></span><p>성공<strong>{succeeded}</strong></p></div>
        <div><span className="card-icon icon-violet"><Icon name="compare" /></span><p>비교<strong>{comparisons.length}</strong></p></div>
        <div><span className="card-icon icon-blue"><Icon name="deploy" /></span><p>Dry-run<strong>{deployments.filter((job) => job.kind === 'DRY_RUN').length}</strong></p></div>
      </section>
      <section className="history-panel" aria-labelledby="history-heading">
        <div className="history-toolbar">
          <div><h2 id="history-heading">모든 실행</h2></div>
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
  const [testClassSuffix, setTestClassSuffix] = useState('_Test');
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const canUpload = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);
  const canEditSettings = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);
  const orgs = workspace?.sources.filter((source) => source.kind === 'org') ?? [];
  const uploadedSources = workspace?.sources.filter((source) => source.location === 'upload') ?? [];

  useEffect(() => {
    setWorkspace(initialWorkspace);
  }, [initialWorkspace]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsLoading(true);
    apiRequest<{ settings: UserSettings }>('/api/v1/settings', { signal: controller.signal })
      .then((data) => {
        setTestClassSuffix(data.settings.testClassSuffix);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setSettingsError(caught instanceof Error ? caught.message : '배포 설정을 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setSettingsLoading(false); });
    return () => controller.abort();
  }, []);

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEditSettings || settingsLoading || settingsSaving) return;
    setSettingsSaving(true);
    setSettingsMessage('');
    setSettingsError('');
    try {
      const data = await apiRequest<{ settings: UserSettings }, UserSettings>('/api/v1/settings', {
        method: 'PUT',
        csrf: true,
        body: { testClassSuffix },
      });
      setTestClassSuffix(data.settings.testClassSuffix);
      setSettingsMessage(`테스트 클래스 접미사를 ${data.settings.testClassSuffix}(으)로 저장했습니다.`);
    } catch (caught) {
      setSettingsError(caught instanceof Error ? caught.message : '배포 설정을 저장하지 못했습니다.');
    } finally {
      setSettingsSaving(false);
    }
  };

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
      const data = await apiRequest<{ source: WorkspaceSource }, FormData>('/api/v1/uploads/projects', {
        method: 'POST',
        csrf: true,
        body: form,
      });
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
      />
      <div className="settings-grid">
        <section className="workflow-panel" aria-labelledby="server-heading">
          <div className="panel-heading"><span className="card-icon icon-green"><Icon name="activity" /></span><div><h2 id="server-heading">UI 서버</h2></div><StatusPill label="실행 중" state="online" /></div>
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
          <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="cloud" /></span><div><h2 id="cli-heading">Salesforce CLI</h2></div><StatusPill label="연결됨" state="online" /></div>
          <div className="connection-card"><div className="avatar-stack large"><span>SF</span><i /></div><div><strong>{orgs.length}개 org 사용 가능</strong><p>{orgs.map((org) => org.label).join(' · ') || '연결 확인 중'}</p></div><button type="button" onClick={() => window.location.reload()}><Icon name="refresh" />새로고침</button></div>
        </section>
        <section className="workflow-panel settings-wide" aria-labelledby="deployment-settings-heading">
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="deploy" /></span><div><h2 id="deployment-settings-heading">배포 테스트 규칙</h2></div></div>
          <form className="settings-form" onSubmit={(event) => void saveSettings(event)}>
            <label><span>테스트 클래스 접미사</span><input value={testClassSuffix} onChange={(event) => setTestClassSuffix(event.target.value)} placeholder="_Test" disabled={!canEditSettings || settingsLoading || settingsSaving} maxLength={40} aria-describedby="test-class-suffix-help" /></label>
            <button className={`button button-primary${settingsSaving ? ' button-busy' : ''}`} type="submit" disabled={!canEditSettings || settingsLoading || settingsSaving || testClassSuffix.trim().length === 0}><Icon name={settingsSaving ? 'refresh' : 'check'} />{settingsSaving ? '저장 중……' : '접미사 저장'}</button>
            <p id="test-class-suffix-help"><Icon name="shield" /><span>예: <code>_Test</code>를 지정하면 <code>AccountService_Test.cls</code>를 자동 선택합니다. 영문자, 숫자, 밑줄만 사용할 수 있습니다.</span></p>
          </form>
          {settingsMessage && <p className="upload-message" role="status">{settingsMessage}</p>}
          {settingsError && <p className="upload-message settings-error" role="alert">{settingsError}</p>}
          {!canEditSettings && <p className="upload-message">VIEWER 역할은 배포 테스트 규칙을 변경할 수 없습니다.</p>}
        </section>
        <section className="workflow-panel settings-wide" aria-labelledby="project-heading">
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="folder" /></span><div><h2 id="project-heading">명시적으로 등록된 서버 프로젝트</h2></div></div>
          {workspace === null
            ? <p className="empty-runs">프로젝트 확인 중입니다.</p>
            : workspace.projects.length === 0
              ? <p className="empty-runs">등록된 서버 프로젝트가 없습니다. 서버 시작 시 <code>--project</code>를 지정하세요.</p>
              : workspace.projects.map((project) => <div className="project-row" key={project.id}><span className="project-logo"><Icon name="code" /></span><div><strong>{project.displayName}</strong><code>Manifest {project.manifests.length}개</code></div><span className="tag tag-green">SERVER</span><span aria-hidden="true"><Icon name="chevron" /></span></div>)}
        </section>
        <section className="workflow-panel settings-wide" aria-labelledby="upload-project-heading">
          <div className="panel-heading">
            <span className="card-icon icon-blue"><Icon name="plus" /></span>
            <div><h2 id="upload-project-heading">내 단말기 프로젝트</h2></div>
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

function isUploadableProjectFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => ['.git', '.sf', '.sfdx', 'node_modules'].includes(segment))) return false;
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  return basename !== '.env'
    && !basename.startsWith('.env.')
    && !['.key', '.pem', '.p12', '.pfx'].some((extension) => basename.endsWith(extension));
}
