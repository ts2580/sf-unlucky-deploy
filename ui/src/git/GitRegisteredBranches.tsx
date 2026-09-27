import { useEffect, useState } from 'react';
import type { GitRegistration } from '../../../src/git/git-registration-service';
import { apiRequest } from '../api-client';
import { errorMessage } from './api';

export function GitRegisteredBranches({ canEdit, revision }: { canEdit: boolean; revision: number }) {
  const [items, setItems] = useState<GitRegistration[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const load = () => apiRequest<{ registrations: GitRegistration[] }>('/api/v1/git/registrations', { signal: controller.signal })
      .then((response) => { if (live) { setItems(response.registrations); setError(''); } })
      .catch((cause) => { if (live) setError(errorMessage(cause)); });
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [revision, refresh]);
  const mutate = async (id: string, remove: boolean) => {
    setBusy(id); setError('');
    try {
      await apiRequest(`/api/v1/git/registrations/${encodeURIComponent(id)}${remove ? '' : '/sync'}`,
        { method: remove ? 'DELETE' : 'POST', csrf: true });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(undefined); setRefresh((value) => value + 1); }
  };
  const names: Record<string, string> = { PENDING: '준비 대기', SYNCING: '동기화 중', READY: '사용 가능', FAILED: '동기화 실패' };
  return <section className="workflow-panel settings-wide git-panel" aria-labelledby="git-registered-heading">
    <div className="panel-heading"><div><h2 id="git-registered-heading">등록 배포 브랜치</h2>
      <p>Git 저장소를 재사용하고, 비교 시작 시 최신 변경을 확인합니다. 비교한 소스는 배포까지 고정됩니다.</p></div></div>
    {items.length === 0 && <p>등록한 배포 브랜치가 없습니다.</p>}
    <div className="git-project-list">{items.map((item) => <article className="git-project" key={item.id}>
      <strong>{item.request.repositoryPath} · {item.request.ref.name}</strong><span className="tag">{names[item.status] ?? item.status}</span>
      <p>프로젝트 경로: {item.request.projectRoot ?? '.'}</p>
      {item.lastCommitSha && <code className="git-sha">{item.lastCommitSha}</code>}
      {item.lastSyncedAt && <p>마지막 동기화: <time dateTime={item.lastSyncedAt}>{new Date(item.lastSyncedAt).toLocaleString('ko-KR')}</time></p>}
      {item.errorMessage && <p role="alert" className="settings-error">{item.errorMessage}</p>}
      <div className="git-actions"><a className="small-button" href="/deploy">비교에서 사용</a>
        {canEdit && <><button type="button" className="small-button" disabled={busy !== undefined || item.status === 'SYNCING'} onClick={() => void mutate(item.id, false)}>지금 동기화</button>
          <button type="button" className="small-button" disabled={busy !== undefined || item.status === 'SYNCING'} onClick={() => void mutate(item.id, true)}>등록 해제</button></>}
      </div>
    </article>)}</div>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}
