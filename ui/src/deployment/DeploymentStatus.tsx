import { useEffect, useState } from 'react';

import type { DeploymentJobResponse } from '../../../src/api/deployment-contracts';
import type { ComparisonJobResponse } from '../comparison/api';
import { Icon } from '../components/Icon';
import { formatDuration } from '../duration';

type DryRunJobResponse = DeploymentJobResponse;
type SalesforceDeploymentDiagnostics = NonNullable<
  NonNullable<DeploymentJobResponse['progress']>['diagnostics']
>;

function deploymentTestResult(job: DryRunJobResponse): string {
  const plan = job.testPlan;
  if (plan === undefined) return '테스트 수준 미상';
  if (plan.tests.length > 0) {
    return `${plan.tests.join(', ')} · 코드 커버리지 ${job.testCoverage?.toFixed(2) ?? '확인 완료'}%`;
  }
  return plan.level === 'NoTestRun'
    ? 'NoTestRun · 테스트 없이 target org에 반영했습니다.'
    : `${plan.level} · Salesforce 구성 테스트를 실행했습니다.`;
}
export type LiveStatus = 'connecting' | 'connected' | 'reconnecting';

export function WorkflowStatusPanel({
  liveStatus,
  comparisonJob,
  deploymentJob,
  deploymentSubmitting,
}: {
  liveStatus: LiveStatus;
  comparisonJob: ComparisonJobResponse | null;
  deploymentJob: DryRunJobResponse | null;
  deploymentSubmitting: boolean;
}) {
  const running = deploymentSubmitting || [comparisonJob?.status, deploymentJob?.status]
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
    deploymentSubmitting && deploymentJob === null
      ? { title: '실제 배포', label: '요청 제출 중', detail: '서버에 배포 작업 생성 요청을 전송함', tone: 'pending' as const }
      : workflowStatusItem('실제 배포', deploymentJob, now),
  ];
  return (
    <section className="workflow-status-panel" aria-labelledby="workflow-status-heading" aria-live="polite">
      <div className="workflow-status-head">
        <div><span className="card-icon icon-blue"><Icon name="activity" /></span><span><h2 id="workflow-status-heading">실행 현황</h2></span></div>
        <span className={`live-status live-status-${liveStatus}`}><i />{connectionLabel}</span>
      </div>
      <div className="workflow-status-grid">
        {items.map((item) => <article className={`workflow-status-card workflow-status-${item.tone}`} key={item.title} aria-label={`${item.title} 현황`}>
          <span>{item.title}</span>
          <strong>{item.label}</strong>
          <small>{item.detail}</small>
        </article>)}
      </div>
    </section>
  );
}

export function SubmissionProgress({ kind }: { kind: 'Dry-run' }) {
  return (
    <section className="dry-run-live-progress dry-run-live-pending" aria-label={`${kind} 현황`} aria-live="assertive">
      <div className="dry-run-live-head"><span><Icon name="refresh" />{kind} 요청 제출 중</span></div>
      <strong>서버 응답 대기 중</strong>
      <small>작업을 생성하고 있습니다. 잠시만 기다려 주세요.</small>
    </section>
  );
}

export function DryRunLiveProgress({ liveStatus, job }: { liveStatus: LiveStatus; job: DryRunJobResponse }) {
  const running = ['QUEUED', 'DRY_RUN_RUNNING'].includes(job.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);
  const status = workflowStatusItem('Dry-run', job, now);
  const connectionLabel = liveStatus === 'connected'
    ? 'SSE 연결됨'
    : liveStatus === 'reconnecting'
      ? 'SSE 재연결 중'
      : 'SSE 연결 중';

  return (
    <section className={`dry-run-live-progress dry-run-live-${status.tone}`} aria-label="Dry-run 현황" aria-live="polite">
      <div className="dry-run-live-head">
        <span><Icon name="activity" />Dry-run 진행 상황</span>
        <span className={`live-status live-status-${liveStatus}`}><i />{connectionLabel}</span>
      </div>
      <strong>{status.label}</strong>
      <small>{status.detail}</small>
      <DryRunLiveDiagnostics diagnostics={job.progress?.diagnostics} />
    </section>
  );
}

function DryRunLiveDiagnostics({ diagnostics }: { diagnostics: SalesforceDeploymentDiagnostics | undefined }) {
  if (diagnostics === undefined) return null;
  return (
    <div className="dry-run-live-diagnostics">
      <strong>실패 원인</strong>
      {diagnostics.componentFailures.map((failure, index) => <article key={`${failure.fullName ?? failure.fileName ?? 'component'}-${index}`}>
        <b>{[failure.componentType, failure.fullName].filter(Boolean).join(' · ') || '컴포넌트 오류'}</b>
        {(failure.fileName !== undefined || failure.lineNumber !== undefined) && <code>{failure.fileName ?? '파일 미상'}{failure.lineNumber === undefined ? '' : `:${failure.lineNumber}${failure.columnNumber === undefined ? '' : `:${failure.columnNumber}`}`}</code>}
        <span>{failure.problem}</span>
      </article>)}
      {diagnostics.testFailures.map((failure, index) => <article key={`${failure.name ?? 'test'}-${failure.methodName ?? index}`}>
        <b>{[failure.name, failure.methodName].filter(Boolean).join('.') || 'Apex 테스트 실패'}</b>
        <span>{failure.message}</span>
        {failure.stackTrace !== undefined && <code>{failure.stackTrace}</code>}
      </article>)}
      {[...diagnostics.codeCoverageWarnings, ...diagnostics.flowCoverageWarnings].map((warning, index) => <article key={`${warning.name ?? 'coverage'}-${index}`}>
        <b>{warning.name === undefined ? '커버리지 경고' : `커버리지 · ${warning.name}`}</b>
        <span>{warning.message}</span>
      </article>)}
      {diagnostics.messages.map((message, index) => <article key={`${message}-${index}`}><span>{message}</span></article>)}
    </div>
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
  const elapsed = seconds === undefined ? '' : ` · 소요시간 ${formatDuration(seconds)}`;
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
  if (status === 'APPROVAL_PENDING') {
    return { title, label: `Dry-run 성공 · 배포 가능${elapsed}`, detail, tone: 'success' };
  }
  return {
    title,
    label: `완료${elapsed}`,
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

export function DryRunResultPanel({
  job,
  canReconcile,
  reconciling,
  onReconcile,
}: {
  job: DryRunJobResponse;
  canReconcile: boolean;
  reconciling: boolean;
  onReconcile: (job: DryRunJobResponse) => Promise<void>;
}) {
  if (job.kind === 'DEPLOY' && ['QUEUED', 'DEPLOYING'].includes(job.status)) {
    return <><section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? '실제 배포 대기 중' : `Salesforce 실제 배포 중${job.progress === undefined ? '' : ` · ${job.progress.status}`}`}</strong><p>{job.progress === undefined ? `${job.source.label} → ${job.target.label} · dry-run으로 고정한 payload를 배포합니다.` : progressSummary(job.progress)}</p></div></section><SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} /></>;
  }
  if (['QUEUED', 'DRY_RUN_RUNNING'].includes(job.status)) {
    return <><section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{job.status === 'QUEUED' ? 'dry-run 대기 중' : `Salesforce check-only 실행 중${job.progress === undefined ? '' : ` · ${job.progress.status}`}`}</strong><p>{job.progress === undefined ? `${job.source.label} → ${job.target.label} · snapshot, 차이, 테스트를 검증합니다.` : progressSummary(job.progress)}</p></div></section><SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} /></>;
  }
  if (job.status === 'FAILED' || job.status === 'RECONCILE_REQUIRED') {
    return <section className="compare-error" role="alert"><strong>{job.status === 'FAILED' ? `${job.kind === 'DEPLOY' ? '실제 배포' : 'dry-run'}이 실패했습니다.` : 'Salesforce 상태 재확인이 필요합니다.'}</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p>{job.persistenceWarning !== undefined && <p>로컬 저장 경고: {job.persistenceWarning}</p>}{job.status === 'RECONCILE_REQUIRED' && <button className={`button button-secondary reconcile-button${reconciling ? ' button-busy' : ''}`} type="button" disabled={!canReconcile || reconciling} onClick={() => void onReconcile(job)}><Icon name={reconciling ? 'refresh' : 'shield'} />{reconciling ? 'Salesforce 상태 확인 중……' : 'Salesforce 상태 다시 확인'}</button>}<SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} /></section>;
  }
  if (job.kind === 'DEPLOY' && job.status === 'SUCCEEDED') {
    return <section className="dry-run-result" aria-label="Salesforce 실제 배포 성공"><div className="comparison-result-head"><div><p className="eyebrow">DEPLOYMENT COMPLETE</p><h2>Salesforce 실제 배포 성공</h2><small>{job.salesforceDeploymentId ?? 'deployment ID 없음'}</small></div><span className="result-success"><Icon name="check" />배포 성공</span></div>{job.persistenceWarning !== undefined && <div className="warning-note" role="alert"><Icon name="shield" /><p><strong>Salesforce 배포는 성공했지만 로컬 저장을 확인해야 합니다.</strong>{job.persistenceWarning}</p></div>}<div className="approval-preview"><Icon name="shield" /><div><strong>선택한 payload 배포를 완료했습니다.</strong><p>{deploymentTestResult(job)}</p></div></div><SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} /></section>;
  }
  if (job.status !== 'APPROVAL_PENDING') return null;
  if (job.persistenceWarning !== undefined || !job.prepared) {
    return <section className="compare-error" role="alert"><strong>Salesforce dry-run은 성공했지만 로컬 결과 저장을 확인해야 합니다.</strong><p>{job.persistenceWarning ?? '고정된 payload를 준비하지 못했습니다.'}</p><p>이 결과로 실제 배포를 승인하지 말고 dry-run을 다시 실행하세요.</p><SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} /></section>;
  }
  const summary = job.comparisonSummary;
  return (
    <section className="dry-run-result" aria-labelledby="dry-run-result-title">
      <div className="comparison-result-head"><div><p className="eyebrow">CHECK-ONLY COMPLETE</p><h2 id="dry-run-result-title">Salesforce dry-run 성공</h2><small>{job.salesforceDeploymentId ?? 'deployment ID 없음'}</small></div><span className="result-success"><Icon name="check" />검증 성공</span></div>
      {summary !== undefined && <div className="comparison-summary"><div className="summary-added"><span>NEW</span><strong>{summary.added}</strong></div><div className="summary-removed"><span>TARGET ONLY</span><strong>{summary.removed}</strong></div><div className="summary-modified"><span>MODIFIED</span><strong>{summary.modified}</strong></div><div><span>TOTAL</span><strong>{summary.total}</strong></div></div>}
      <div className="dry-run-details">
        <div><span className="card-icon icon-green"><Icon name="check" /></span><p><strong>{job.testPlan?.level ?? '테스트 수준 미상'}</strong>{job.testPlan?.tests.length ? `${job.testPlan.tests.join(', ')}${job.testCoverage === undefined ? '' : ` · ${job.testCoverage.toFixed(2)}%`}` : 'Salesforce 구성 테스트'}</p></div>
        <div><span className="card-icon icon-blue"><Icon name="shield" /></span><p><strong>Payload 고정</strong><code>{job.payloadChecksum}</code></p></div>
      </div>
      <div className="approval-preview"><Icon name="shield" /><div><strong>Target 배포 준비가 완료되었습니다.</strong><p>오른쪽 배포 버튼을 누르면 동일 payload를 선택한 target org에 제출합니다.</p></div></div>
      <SalesforceDiagnosticsPanel diagnostics={job.progress?.diagnostics} />
    </section>
  );
}

function SalesforceDiagnosticsPanel({ diagnostics }: { diagnostics: SalesforceDeploymentDiagnostics | undefined }) {
  if (diagnostics === undefined) return null;
  const warnings = [
    ...diagnostics.codeCoverageWarnings.map((warning) => ({ ...warning, kind: 'Apex 커버리지' })),
    ...diagnostics.flowCoverageWarnings.map((warning) => ({ ...warning, kind: 'Flow 커버리지' })),
  ];
  return (
    <section className="salesforce-diagnostics" aria-label="Salesforce 상세 결과">
      <div className="salesforce-diagnostics-head">
        <span><Icon name="code" /></span>
        <div><strong>Salesforce 상세 결과</strong><p>배포 보고서 JSON에서 오류와 경고를 파싱했습니다.</p></div>
      </div>
      {diagnostics.componentFailures.length > 0 && <div className="salesforce-diagnostic-group">
        <h3>컴포넌트 오류 <span>{diagnostics.componentFailures.length}</span></h3>
        {diagnostics.componentFailures.map((failure, index) => <article key={`${failure.fullName ?? failure.fileName ?? 'component'}-${index}`}>
          <strong>{[failure.componentType, failure.fullName].filter(Boolean).join(' · ') || '컴포넌트 오류'}</strong>
          {(failure.fileName !== undefined || failure.lineNumber !== undefined) && <code>{failure.fileName ?? '파일 미상'}{failure.lineNumber === undefined ? '' : `:${failure.lineNumber}${failure.columnNumber === undefined ? '' : `:${failure.columnNumber}`}`}</code>}
          <p>{failure.problemType === undefined ? failure.problem : `${failure.problemType} · ${failure.problem}`}</p>
        </article>)}
      </div>}
      {diagnostics.testFailures.length > 0 && <div className="salesforce-diagnostic-group">
        <h3>Apex 테스트 실패 <span>{diagnostics.testFailures.length}</span></h3>
        {diagnostics.testFailures.map((failure, index) => <article key={`${failure.name ?? 'test'}-${failure.methodName ?? index}`}>
          <strong>{[failure.name, failure.methodName].filter(Boolean).join('.') || 'Apex 테스트 실패'}</strong>
          <p>{failure.message}</p>
          {failure.stackTrace !== undefined && <pre>{failure.stackTrace}</pre>}
        </article>)}
      </div>}
      {warnings.length > 0 && <div className="salesforce-diagnostic-group salesforce-warning-group">
        <h3>검증 경고 <span>{warnings.length}</span></h3>
        {warnings.map((warning, index) => <article key={`${warning.kind}-${warning.name ?? index}`}><strong>{warning.kind}{warning.name === undefined ? '' : ` · ${warning.name}`}</strong><p>{warning.message}</p></article>)}
      </div>}
      {diagnostics.messages.length > 0 && <div className="salesforce-diagnostic-group">
        <h3>Salesforce 메시지 <span>{diagnostics.messages.length}</span></h3>
        {diagnostics.messages.map((message, index) => <article key={`${message}-${index}`}><p>{message}</p></article>)}
      </div>}
    </section>
  );
}
