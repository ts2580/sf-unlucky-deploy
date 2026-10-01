import type { WorkspaceSource } from '../../../src/api/workspace-contracts';
import { useEffect, useState } from 'react';

import { ComparisonFileDiff } from '../ComparisonFileDiff';
import { Icon } from '../components/Icon';
import type { ComparisonComponent, ComparisonJobResponse } from './api';
import { getComparisonJob } from './api';

const METADATA_RESULTS_PER_PAGE = 20;
const VISIBLE_RESULT_PAGES = 5;


export function WorkspaceSourceSelect({
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
      <span><strong>{selected?.label ?? '소스 조회 중'}</strong><small>{selected === undefined ? '연결 상태를 확인하고 있습니다.' : sourceDescription(selected)}</small></span>
      <Icon name="chevron" />
      <select aria-label={`${side} 비교 소스`} value={value} onChange={(event) => onChange(event.target.value)} disabled={sources.length === 0}>
        {value === '' && <option value="" disabled>소스를 선택하세요.</option>}
        {sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {sourceDescription(source)}</option>)}
      </select>
    </label>
  );
}

function sourceDescription(source: WorkspaceSource): string {
  if (source.location === 'git' && source.provenance !== undefined) {
    return `Git · ${source.provenance.refName} · ${source.provenance.commitSha.slice(0, 12)}`;
  }
  return source.detail ?? (source.kind === 'local' ? '프로젝트 소스' : '연결된 org');
}

export function ComparisonResultPanel({
  job,
  deploymentView = false,
  selectedKeys = new Set<string>(),
  onSelectionChange,
  selectionDisabled = false,
  comparisonOnly = false,
}: {
  job: ComparisonJobResponse;
  deploymentView?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (component: ComparisonComponent, selected: boolean) => void;
  selectionDisabled?: boolean;
  comparisonOnly?: boolean;
}) {
  const [resultPage, setResultPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ComparisonComponent['status']>('ALL');
  const [query, setQuery] = useState('');
  const [expandedResult, setExpandedResult] = useState<{ id: string; components: ComparisonComponent[] }>();
  const [identicalLoading, setIdenticalLoading] = useState(false);
  const [filterError, setFilterError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const components = expandedResult?.id === job.id ? expandedResult.components : job.result?.components ?? [];
  const identicalMissing = (job.result?.summary.identical ?? 0) > components.filter((item) => item.status === 'IDENTICAL').length;
  useEffect(() => { setResultPage(1); setStatusFilter('ALL'); setQuery(''); setExpandedResult(undefined); setFilterError(''); }, [job.id]);
  useEffect(() => {
    if (statusFilter !== 'IDENTICAL' || !identicalMissing) { setIdenticalLoading(false); return; }
    const controller = new AbortController();
    setIdenticalLoading(true); setFilterError('');
    void getComparisonJob(job.id, controller.signal, true).then((response) => {
      if (!controller.signal.aborted && response.job.id === job.id && response.job.result !== undefined) {
        setExpandedResult({ id: job.id, components: response.job.result.components });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFilterError(error instanceof Error ? error.message : '동일 항목을 불러오지 못했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setIdenticalLoading(false); });
    return () => controller.abort();
  }, [job.id, statusFilter, identicalMissing, loadAttempt]);
  const sourceOnly = job.result?.comparisonLimit?.exceeded === true || (deploymentView && job.mode === 'source');
  const displaySource = deploymentView || sourceOnly ? job.right : job.left;
  const displayTarget = deploymentView ? job.left : job.right;
  if (job.status === 'QUEUED' || job.status === 'RUNNING') {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{sourceOnly ? (job.status === 'QUEUED' ? '메타데이터 수집 대기 중' : 'Source 메타데이터 받는 중') : (job.status === 'QUEUED' ? '비교 대기 중' : '메타데이터 비교 중')}</strong><p>{sourceOnly ? `${displaySource.label} · ${job.manifest}` : `${displaySource.label} → ${displayTarget.label} · ${job.manifest}`}</p></div></section>;
  }
  if (job.status === 'FAILED') {
    return <section className="compare-error" role="alert"><strong>{sourceOnly ? '메타데이터를 받아오지 못했습니다.' : '비교 작업이 실패했습니다.'}</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
  }
  if (job.result === undefined) return null;
  const summary = job.result.summary;
  const search = query.trim().toLocaleLowerCase();
  const filteredComponents = components.filter((component) =>
    (statusFilter === 'ALL' || component.status === statusFilter) && (search === '' ||
      [component.fullName, component.type, ...component.files.map((file) => file.path)].some((text) => text.toLocaleLowerCase().includes(search))));
  const resultPageCount = Math.max(1, Math.ceil(filteredComponents.length / METADATA_RESULTS_PER_PAGE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const firstVisiblePage = Math.max(1, Math.min(currentResultPage - 2, resultPageCount - VISIBLE_RESULT_PAGES + 1));
  const visiblePages = Array.from({ length: Math.min(VISIBLE_RESULT_PAGES, resultPageCount) }, (_, index) => firstVisiblePage + index);
  const resultStart = (currentResultPage - 1) * METADATA_RESULTS_PER_PAGE;
  const visibleComponents = filteredComponents.slice(resultStart, resultStart + METADATA_RESULTS_PER_PAGE);
  const chooseStatus = (status: typeof statusFilter) => {
    setStatusFilter(status); setResultPage(1); setFilterError(''); setLoadAttempt((value) => value + 1);
  };
  return (
    <section className="comparison-result" aria-labelledby="comparison-result-title">
      <div className="comparison-result-head">
        <div><p className="eyebrow">{sourceOnly ? 'SOURCE METADATA' : 'COMPARISON COMPLETE'}</p><h2 id="comparison-result-title">{sourceOnly ? displaySource.label : `${displaySource.label} → ${displayTarget.label}`}</h2><small>{job.manifest}</small></div>
        <span className="result-success"><Icon name="check" />{job.result.comparisonLimit?.exceeded === true ? '비교 제한 초과 · 배포 목록 준비 완료' : sourceOnly ? '받아오기 완료' : '비교 완료'}</span>
      </div>
      {[job.right, ...(sourceOnly ? [] : [job.left])].filter((source) => source.provenance !== undefined).map((source) =>
        <p className="git-sha" key={source.id}>비교 기준: {source.label} · {source.provenance!.refName} · <code>{source.provenance!.commitSha}</code>
          {' · '}동기화 <time dateTime={source.provenance!.importedAt}>{new Date(source.provenance!.importedAt).toLocaleString('ko-KR')}</time></p>)}
      {sourceOnly
        ? <div className="comparison-summary source-metadata-summary"><div className="summary-added"><span>SOURCE</span><strong>{summary.total}</strong></div></div>
        : <div className="comparison-summary" role="group" aria-label="메타데이터 상태 필터">
            {([
              ['ADDED', deploymentView ? 'NEW' : 'ADDED', summary.added, 'summary-added'],
              ['REMOVED', deploymentView ? 'TARGET ONLY' : 'REMOVED', summary.removed, 'summary-removed'],
              ['MODIFIED', 'MODIFIED', summary.modified, 'summary-modified'],
              ['IDENTICAL', 'IDENTICAL', summary.identical, ''],
            ] as const).map(([status, label, count, className]) => <button key={status} type="button" className={className}
              aria-pressed={statusFilter === status} onClick={() => chooseStatus(status)}><span>{label}</span><strong>{count}</strong></button>)}
          </div>}
      <div className="metadata-result-filters">
        {!sourceOnly && <button type="button" className="small-button" aria-pressed={statusFilter === 'ALL'} onClick={() => chooseStatus('ALL')}>전체</button>}
        <label>메타데이터 검색<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setResultPage(1); }}
          placeholder="이름 · 타입 · 파일 경로 검색" autoComplete="off" /></label>
        <span role="status">{filteredComponents.length}개 일치 · 전체 {components.length}개</span>
        {(query !== '' || statusFilter !== 'ALL') && <button type="button" className="small-button" onClick={() => { setQuery(''); chooseStatus('ALL'); }}>필터 초기화</button>}
      </div>
      {identicalLoading && <p className="comparison-warning" role="status">동일 항목 불러오는 중…</p>}
      {filterError && <p className="comparison-warning" role="alert">{filterError} <button type="button" onClick={() => chooseStatus('IDENTICAL')}>다시 시도</button></p>}
      {job.result.warnings.map((warning) => <p className="comparison-warning" key={warning}><Icon name="shield" />{warning}</p>)}
      {deploymentView && !comparisonOnly && !sourceOnly && summary.removed > 0 && <p className="comparison-warning"><Icon name="shield" />TARGET ONLY 항목은 destructive manifest 없이는 target org에서 삭제되지 않습니다.</p>}
      <div className="component-results">
        {filteredComponents.length === 0
          ? !identicalLoading && !filterError && <p className="empty-result">{query.trim() !== '' || statusFilter !== 'ALL' ? '선택한 상태와 검색 조건에 맞는 메타데이터가 없습니다.' : sourceOnly ? 'Source에서 받아온 메타데이터가 없습니다.' : '표시할 차이가 없습니다. 동일 항목은 IDENTICAL을 눌러 확인하세요.'}</p>
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
              </label>}<span className={`component-status status-${component.status.toLowerCase()}`}>{sourceOnly ? 'SOURCE' : deploymentView ? deploymentDiffStatusLabel(component.status) : component.status}</span><div><strong>{component.fullName}</strong><small>{component.type} · 파일 {component.files.length}개{deploymentView && component.status === 'REMOVED' ? ' · 소스에 없어 선택 불가' : ''}</small></div><Icon name="chevron" /></summary>
              <div className="component-files">{component.files.map((file) => <article key={file.path}><div><code>{file.path}</code><span>{sourceOnly ? 'SOURCE' : file.status}</span></div>{!sourceOnly && <ComparisonFileDiff file={file} sourceLabel={displaySource.label} targetLabel={displayTarget.label} sourceSide={deploymentView ? 'after' : 'before'} />}</article>)}</div>
            </details>)}
        {filteredComponents.length > METADATA_RESULTS_PER_PAGE && <nav className="component-pagination" aria-label="메타데이터 검색 결과 페이지">
          <button type="button" className="component-page-previous" onClick={() => setResultPage(Math.max(1, currentResultPage - 1))} disabled={currentResultPage === 1} aria-label="이전 페이지"><Icon name="chevron" />이전</button>
          <div className="component-page-numbers">{visiblePages.map((page) => <button key={page} type="button"
            aria-label={`${page} 페이지`} aria-current={page === currentResultPage ? 'page' : undefined}
            onClick={() => setResultPage(page)}>{page}</button>)}</div>
          <button type="button" className="component-page-next" onClick={() => setResultPage(Math.min(resultPageCount, currentResultPage + 1))} disabled={currentResultPage === resultPageCount} aria-label="다음 페이지">다음<Icon name="chevron" /></button>
          <span className="component-page-summary" aria-live="polite"><strong>{currentResultPage}</strong> / {resultPageCount}페이지 · {resultStart + 1}-{Math.min(resultStart + METADATA_RESULTS_PER_PAGE, filteredComponents.length)} / {filteredComponents.length}개</span>
        </nav>}
      </div>
    </section>
  );
}


function deploymentDiffStatusLabel(status: ComparisonComponent['status']): string {
  if (status === 'ADDED') return 'NEW';
  if (status === 'REMOVED') return 'TARGET ONLY';
  return status;
}
