import { useEffect, useState } from 'react';
import type { GitImport } from '../../../src/api/git-project-contracts';
import { apiRequest } from '../api-client';
import { errorMessage, imports, providerNames } from './api';

const active = new Set(['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING']);
const statusNames: Record<string, string> = { QUEUED: '대기 중', FETCHING: '받는 중', SELECTING: '프로젝트 선택 필요',
  MATERIALIZING: '소스 준비 중', READY: '사용 가능', FAILED: '실패', CANCELLED: '취소됨', EXPIRED: '만료됨', DELETED: '삭제됨' };

export function GitProjectList({ canEdit, revision, onReimport }: {
  canEdit: boolean; revision: number; onReimport(value: GitImport): void;
}) {
  const [items, setItems] = useState<GitImport[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await imports();
        if (live) { setItems(response.imports); setError(''); }
      } catch (cause) { if (live) setError(errorMessage(cause)); }
      if (live) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [revision, refresh]);

  const mutate = async (item: GitImport, operation: 'cancel' | 'delete' | 'select-project', projectRoot?: string) => {
    if (!canEdit || busy !== undefined) return;
    setBusy(item.id); setError('');
    try {
      await apiRequest(`/api/v1/git/imports/${encodeURIComponent(item.id)}${operation === 'delete' ? '' : `/${operation}`}`,
        { method: operation === 'delete' ? 'DELETE' : 'POST', csrf: true, ...(projectRoot === undefined ? {} : { body: { projectRoot } }) });
      setRefresh((value) => value + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(undefined); }
  };
  return <section className="workflow-panel settings-wide git-panel" aria-labelledby="git-projects-heading">
    <div className="panel-heading"><div><h2 id="git-projects-heading">내 Git 프로젝트</h2><p>소스는 마지막 사용 후 4시간 동안 유지됩니다. 다시 가져오면 별도 소스가 생성됩니다.</p><p>소스를 삭제해도 실행 이력과 이미 준비된 배포 자료는 유지됩니다.</p></div></div>
    {items.filter((item) => item.status !== 'DELETED').length === 0 && <p>가져온 Git 프로젝트가 없습니다.</p>}
    <div className="git-project-list">{items.filter((item) => item.status !== 'DELETED').map((item) => <article className="git-project" key={item.id} aria-label={`${item.repositoryPath} 가져오기`}>
      <div className="git-project-heading"><strong>{item.repositoryPath}</strong><span className="tag">{statusNames[item.status] ?? item.status}</span></div>
      <p>{providerNames[item.provider]} · {item.ref.kind} {item.ref.name}{item.metadataType && ` · ${item.metadataType}`}</p>
      <code className="git-sha">{item.expectedCommitSha}</code>
      <p>{item.source?.provenance ? '가져온 시각' : '요청 시각'}: <time dateTime={item.source?.provenance?.importedAt ?? item.createdAt}>{new Date(item.source?.provenance?.importedAt ?? item.createdAt).toLocaleString('ko-KR')}</time></p>
      {item.source?.provenance && <p>프로젝트 루트: <code>{item.source.provenance.projectRoot}</code> · {(item.sizeBytes / 1024).toFixed(1)} KB</p>}
      {item.errorMessage && <p className="settings-error" role="alert">{item.errorMessage}</p>}
      {item.status === 'SELECTING' && <div className="git-roots"><p>가져올 Salesforce DX 프로젝트를 선택하세요.</p>
        {item.projectRoots.map((root) => <button type="button" className="small-button" disabled={!canEdit || busy !== undefined} key={root}
          onClick={() => void mutate(item, 'select-project', root)}>{root} 가져오기</button>)}</div>}
      <div className="git-actions">
        {item.status === 'READY' && <a className="small-button" href="/deploy">비교 및 배포에서 사용</a>}
        {canEdit && (active.has(item.status)
          ? <button type="button" className="small-button" disabled={busy !== undefined} onClick={() => void mutate(item, 'cancel')}>가져오기 취소</button>
          : <><button type="button" className="small-button" disabled={busy !== undefined} onClick={() => onReimport(item)}>다시 가져오기</button>
            <button type="button" className="small-button" disabled={busy !== undefined} onClick={() => void mutate(item, 'delete')}>소스 삭제</button></>)}
      </div>
    </article>)}</div>
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
