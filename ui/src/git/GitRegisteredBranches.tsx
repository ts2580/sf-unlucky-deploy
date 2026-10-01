import { useEffect, useState } from 'react';
import type { GitRegistration } from '../../../src/git/git-registration-service';
import { apiRequest } from '../api-client';
import { errorMessage } from './api';
import { GitAliasEditor } from './GitAliasEditor';
import { Icon } from '../components/Icon';

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
    <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="code" /></span><div><h2 id="git-registered-heading">등록 배포 브랜치</h2>
      <p>Git 저장소를 재사용하고, 비교 시작 시 최신 변경을 확인합니다. 비교한 소스는 배포까지 고정됩니다.</p></div></div>
    {items.length === 0 && <p>등록한 배포 브랜치가 없습니다.</p>}
    {items.length > 0 && <div className="connection-table-scroll" role="region" aria-label="등록 배포 브랜치 표 영역" tabIndex={0}><table className="connection-table git-record-table" aria-label="등록 배포 브랜치"><thead><tr><th scope="col">저장소와 브랜치</th><th scope="col">상태</th><th scope="col">동기화</th><th scope="col">관리</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}>
      <th scope="row"><div className="connection-cell-content"><strong title={item.request.repositoryPath}>{item.alias ?? item.request.repositoryPath} · {item.request.ref.name}</strong>
        {item.alias && <details><summary>저장소 주소</summary><code>{item.request.repositoryPath}</code></details>}
        <span className="connection-cell-secondary">프로젝트 경로: {item.request.projectRoot ?? '.'}</span>
        {item.lastCommitSha && <code className="git-sha">{item.lastCommitSha}</code>}{item.errorMessage && <span role="alert" className="settings-error">{item.errorMessage}</span>}
      </div></th>
      <td><span className="tag">{names[item.status] ?? item.status}</span></td>
      <td>{item.lastSyncedAt ? <time dateTime={item.lastSyncedAt}>{new Date(item.lastSyncedAt).toLocaleString('ko-KR')}</time> : '아직 없음'}</td>
      <td><div className="connection-table-actions"><a className="small-button" href="/deploy">비교에서 사용</a>
        {canEdit && <><button type="button" className="small-button" disabled={busy !== undefined || item.status === 'SYNCING' || item.requiresRepositoryUrl} onClick={() => void mutate(item.id, false)}>지금 동기화</button>
          <button type="button" className="small-button" disabled={busy !== undefined || item.status === 'SYNCING'} onClick={() => void mutate(item.id, true)}>등록 해제</button>
          <GitAliasEditor alias={item.alias} endpoint={`/api/v1/git/registrations/${encodeURIComponent(item.id)}/alias`}
            disabled={busy !== undefined} onSaved={() => setRefresh((value) => value + 1)} /></>}
      </div></td>
    </tr>)}</tbody></table></div>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}
