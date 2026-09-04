import { useEffect, useState } from 'react';

import { ComparisonFileDiff } from '../ComparisonFileDiff';
import { Icon } from '../components/Icon';
import type { ComparisonComponent, ComparisonJobResponse } from './api';

const METADATA_RESULTS_PER_PAGE = 20;

interface WorkspaceSource {
  id: string;
  kind: 'org' | 'local';
  label: string;
  detail: string;
}

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
      <span><strong>{selected?.label ?? '소스 조회 중'}</strong><small>{selected?.detail ?? '연결 상태를 확인하고 있습니다.'}</small></span>
      <Icon name="chevron" />
      <select aria-label={`${side} 비교 소스`} value={value} onChange={(event) => onChange(event.target.value)} disabled={sources.length === 0}>
        {sources.map((source) => <option key={source.id} value={source.id}>{source.label} · {source.detail}</option>)}
      </select>
    </label>
  );
}

export function ComparisonResultPanel({
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
  const sourceOnly = deploymentView && job.mode === 'source';
  const displaySource = deploymentView ? job.right : job.left;
  const displayTarget = deploymentView ? job.left : job.right;
  if (job.status === 'QUEUED' || job.status === 'RUNNING') {
    return <section className="comparison-progress" aria-live="polite"><span><Icon name="refresh" /></span><div><strong>{sourceOnly ? (job.status === 'QUEUED' ? '메타데이터 수집 대기 중' : 'Source 메타데이터 받는 중') : (job.status === 'QUEUED' ? '비교 대기 중' : '메타데이터 비교 중')}</strong><p>{sourceOnly ? `${displaySource.label} · ${job.manifest}` : `${displaySource.label} → ${displayTarget.label} · ${job.manifest}`}</p></div></section>;
  }
  if (job.status === 'FAILED') {
    return <section className="compare-error" role="alert"><strong>{sourceOnly ? '메타데이터를 받아오지 못했습니다.' : '비교 작업이 실패했습니다.'}</strong><p>{job.errorMessage ?? '상세 오류가 기록되지 않았습니다.'}</p></section>;
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
        <div><p className="eyebrow">{sourceOnly ? 'SOURCE METADATA' : 'COMPARISON COMPLETE'}</p><h2 id="comparison-result-title">{sourceOnly ? displaySource.label : `${displaySource.label} → ${displayTarget.label}`}</h2><small>{job.manifest}</small></div>
        <span className="result-success"><Icon name="check" />{sourceOnly ? '받아오기 완료' : '비교 완료'}</span>
      </div>
      {sourceOnly
        ? <div className="comparison-summary source-metadata-summary"><div className="summary-added"><span>SOURCE</span><strong>{summary.total}</strong></div></div>
        : <div className="comparison-summary">
            <div className="summary-added"><span>{deploymentView ? 'NEW' : 'ADDED'}</span><strong>{summary.added}</strong></div>
            <div className="summary-removed"><span>{deploymentView ? 'TARGET ONLY' : 'REMOVED'}</span><strong>{summary.removed}</strong></div>
            <div className="summary-modified"><span>MODIFIED</span><strong>{summary.modified}</strong></div>
            <div><span>IDENTICAL</span><strong>{summary.identical}</strong></div>
          </div>}
      {job.result.warnings.map((warning) => <p className="comparison-warning" key={warning}><Icon name="shield" />{warning}</p>)}
      {deploymentView && !sourceOnly && summary.removed > 0 && <p className="comparison-warning"><Icon name="shield" />TARGET ONLY 항목은 destructive manifest 없이는 target org에서 삭제되지 않습니다.</p>}
      <div className="component-results">
        {job.result.components.length === 0
          ? <p className="empty-result">{sourceOnly ? 'Source에서 받아온 메타데이터가 없습니다.' : '표시할 차이가 없습니다. 두 소스가 동일합니다.'}</p>
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
        {job.result.components.length > METADATA_RESULTS_PER_PAGE && <nav className="component-pagination" aria-label="메타데이터 검색 결과 페이지">
          <button type="button" onClick={() => setResultPage((page) => Math.max(1, page - 1))} disabled={currentResultPage === 1} aria-label="이전 페이지"><Icon name="chevron" />이전</button>
          <span><strong>{currentResultPage}</strong> / {resultPageCount}페이지 · {resultStart + 1}-{Math.min(resultStart + METADATA_RESULTS_PER_PAGE, job.result.components.length)} / {job.result.components.length}개</span>
          <button type="button" onClick={() => setResultPage((page) => Math.min(resultPageCount, page + 1))} disabled={currentResultPage === resultPageCount} aria-label="다음 페이지">다음<Icon name="chevron" /></button>
        </nav>}
      </div>
    </section>
  );
}


function deploymentDiffStatusLabel(status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL'): string {
  if (status === 'ADDED') return 'NEW';
  if (status === 'REMOVED') return 'TARGET ONLY';
  return status;
}
