import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ApiUser } from '../auth/api';
import { GitAllowedIpInputSchema, GitAllowedIpListResponseSchema, type GitAllowedIp } from '../../../src/api/git-contracts';
import { apiRequest } from '../api-client';
import { errorMessage } from './api';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { Icon } from '../components/Icon';

export function GitAllowedIps({ user }: { user: ApiUser }) {
  const [entries, setEntries] = useState<GitAllowedIp[]>([]);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const canManage = user.role === 'ADMIN';
  const refresh = useCallback(async () => {
    const response = await apiRequest<{ allowedIps: GitAllowedIp[] }>('/api/v1/admin/git-allowed-ips', { responseSchema: GitAllowedIpListResponseSchema });
    setEntries(response.allowedIps);
  }, []);

  useEffect(() => {
    if (!canManage) return;
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [canManage, refresh]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiRequest<{ allowedIps: GitAllowedIp[] }, { address: string }>('/api/v1/admin/git-allowed-ips', {
        method: 'POST', csrf: true, body: { address: address.trim() }, requestSchema: GitAllowedIpInputSchema,
        responseSchema: GitAllowedIpListResponseSchema,
      });
      setEntries(response.allowedIps); setAddress(''); setMessage('허용 Git IP를 등록했습니다. 이후 Git 연결부터 즉시 적용됩니다.'); setAdding(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const remove = async (value: string) => {
    if (!canManage || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await apiRequest<{ allowedIps: GitAllowedIp[] }, { address: string }>('/api/v1/admin/git-allowed-ips', {
        method: 'DELETE', csrf: true, body: { address: value }, requestSchema: GitAllowedIpInputSchema,
        responseSchema: GitAllowedIpListResponseSchema,
      });
      setEntries(response.allowedIps); setMessage('허용 Git IP를 제거했습니다. 환경변수 또는 실행 옵션의 IP는 유지됩니다.');
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  if (!canManage) return null;
  return <section className="workflow-panel settings-wide git-panel" aria-labelledby="git-allowed-ip-heading">
    <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="code" /></span><div><h2 id="git-allowed-ip-heading">셀프호스팅 Git 허용 IP</h2><p>사설·예약 IP로 해석되는 Git 서버에만 적용됩니다. 관리자만 변경할 수 있습니다.</p></div><button className="button button-primary" type="button" onClick={() => { setAddress(''); setError(''); setAdding(true); }}><Icon name="plus" />IP 등록</button></div>
    {adding && <ConnectionDialog title="허용 Git IP 등록" busy={busy} onClose={() => setAdding(false)}><form className="settings-form" onSubmit={(event) => void add(event)}>
      <label><span>IPv4 또는 IPv6 주소</span><input value={address} onChange={(event) => setAddress(event.target.value)} maxLength={45} required disabled={busy}
        placeholder="192.168.10.25" autoComplete="off" spellCheck={false} /></label>
      <button className={`button button-primary${busy ? ' button-busy' : ''}`} disabled={busy || address.trim() === ''} type="submit">{busy ? '저장 중……' : '등록'}</button>
      <p>정확한 IP만 등록할 수 있습니다. CIDR·호스트명·URL은 허용하지 않으며, DNS 응답은 등록 IP와 정확히 일치해야 합니다.</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </form></ConnectionDialog>}
    {entries.length === 0 ? <p className="empty-runs">UI에서 등록한 허용 IP가 없습니다.</p> : <div className="connection-table-scroll" role="region" aria-label="허용 Git IP 표 영역" tabIndex={0}><table className="connection-table allowed-ip-table" aria-label="허용 Git IP"><thead><tr><th scope="col">IP 주소</th><th scope="col">등록일</th><th scope="col">관리</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.address}>
      <th scope="row"><code>{entry.address}</code></th><td><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('ko-KR')}</time></td>
      <td><button className="small-button" type="button" disabled={busy} onClick={() => void remove(entry.address)}>제거</button></td>
    </tr>)}</tbody></table></div>}
    {!adding && message && <p role="status">{message}</p>}{!adding && error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
