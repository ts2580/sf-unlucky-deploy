import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import { apiRequest } from '../api-client';
import { Icon } from '../components/Icon';
import { ConnectionTable } from '../components/ConnectionTable';
import { ConnectionDialog } from '../components/ConnectionDialog';

interface SalesforceConnection {
  id: string;
  alias: string;
  orgId?: string;
  username?: string;
  status: 'CONNECTED' | 'REAUTH_REQUIRED';
}

interface ConnectionList {
  localMode: boolean;
  callbackPort?: number;
  storageStatus: 'cli' | 'ready' | 'not_configured' | 'invalid_key';
  oauth?: { ready: boolean; reason?: 'not_configured' | 'https_required' | 'storage_unavailable' };
  connections: SalesforceConnection[];
}

interface LocalLoginStart {
  id: string;
  authorizationUrl: string;
  callbackPort: number;
}

interface LocalLoginStatus {
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  alias: string;
  error?: string;
}

interface SalesforceOAuthStart {
  id: string;
  authorizationUrl: string;
}

export function SalesforceConnections() {
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [data, setData] = useState<ConnectionList>();
  const [alias, setAlias] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [localAlias, setLocalAlias] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('https://login.salesforce.com');
  const [localLoginId, setLocalLoginId] = useState<string>();
  const [localLoginUrl, setLocalLoginUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loadState, setLoadState] = useState<'initial' | 'ready' | 'refreshing' | 'error'>('initial');
  const [loadError, setLoadError] = useState('');
  const completedOAuthFlow = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    setLoadState((current) => current === 'ready' ? 'refreshing' : 'initial');
    setLoadError('');
    try {
      setData(await apiRequest<ConnectionList>('/api/v1/salesforce/connections'));
      setLoadState('ready');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Salesforce 연결을 불러오지 못했습니다.';
      setLoadError(detail);
      setLoadState((current) => current === 'initial' ? 'error' : current === 'refreshing' ? 'ready' : current);
      throw cause;
    }
  }, []);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);

  useEffect(() => {
    const flowId = new URLSearchParams(window.location.search).get('sfudSalesforceOAuth');
    if (flowId === null || completedOAuthFlow.current === flowId) return;
    completedOAuthFlow.current = flowId;
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', cleanUrl);
    setBusy(true); setError(''); setMessage('Salesforce 로그인을 확인하고 연결을 저장하는 중……');
    void (async () => {
      try {
        await apiRequest('/api/v1/salesforce/oauth/complete', {
          method: 'POST', csrf: true, timeoutMs: 90_000, body: { flowId },
        });
        setRegistrationOpen(false);
        setMessage('Salesforce 연결을 저장했습니다.');
        await refresh();
      } catch (cause) {
        setRegistrationOpen(true);
        setMessage('');
        setError(cause instanceof Error ? cause.message : 'Salesforce 연결을 완료하지 못했습니다. 다시 시작하세요.');
      } finally { setBusy(false); }
    })();
  }, [refresh]);

  useEffect(() => {
    if (localLoginId === undefined) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await apiRequest<LocalLoginStatus>(`/api/v1/salesforce/local-login/${encodeURIComponent(localLoginId)}`);
        if (stopped) return;
        if (result.status === 'PENDING') { timer = window.setTimeout(() => { void poll(); }, 1_500); return; }
        setLocalLoginId(undefined);
        setLocalLoginUrl('');
        if (result.status === 'FAILED') { setError(result.error ?? 'Salesforce 로그인이 실패했습니다.'); return; }
        setRegistrationOpen(false);
        setMessage(`${result.alias} Salesforce 로그인이 완료됐습니다.`);
        await refresh();
      } catch (cause) {
        if (stopped) return;
        setLocalLoginId(undefined);
        setError(cause instanceof Error ? cause.message : 'Salesforce 로그인 상태를 확인하지 못했습니다.');
      }
    };
    timer = window.setTimeout(() => { void poll(); }, 1_500);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [localLoginId, refresh]);

  const startLocalLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setBusy(true); setError(''); setMessage(''); setLocalLoginUrl('');
    try {
      const result = await apiRequest<LocalLoginStart, { alias: string; instanceUrl: string }>('/api/v1/salesforce/local-login', {
        method: 'POST', csrf: true, body: { alias: localAlias.trim(), instanceUrl: instanceUrl.trim() },
      });
      setLocalLoginId(result.id);
      setLocalLoginUrl(result.authorizationUrl);
      setMessage('Salesforce 로그인 완료를 기다리고 있습니다.');
      if (popup) popup.location.replace(result.authorizationUrl);
      else setMessage('팝업이 차단됐습니다. 아래 로그인 링크를 여세요.');
    } catch (cause) {
      popup?.close();
      setError(cause instanceof Error ? cause.message : 'Salesforce 로그인을 시작하지 못했습니다.');
    } finally { setBusy(false); }
  };

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedUrl = authUrl;
    setAuthUrl('');
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest('/api/v1/salesforce/connections', {
        method: 'POST', csrf: true, timeoutMs: 90_000,
        body: { alias: alias.trim(), sfdxAuthUrl: submittedUrl },
      });
      setMessage(`${alias.trim()} Salesforce 연결을 등록했습니다.`);
      try { await refresh(); } finally { setRegistrationOpen(false); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Salesforce 연결을 등록하지 못했습니다.');
    } finally { setBusy(false); }
  };

  const startRemoteOAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await apiRequest<SalesforceOAuthStart, { alias: string; instanceUrl: string }>(
        '/api/v1/salesforce/oauth/start', {
          method: 'POST', csrf: true,
          body: { alias: alias.trim(), instanceUrl: instanceUrl.trim() },
        });
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Salesforce 로그인을 시작하지 못했습니다.');
      setBusy(false);
    }
  };

  const remove = async (connection: SalesforceConnection) => {
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest(`/api/v1/salesforce/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE', csrf: true });
      setMessage(`${connection.alias} 연결을 삭제했습니다. Salesforce 측 토큰 폐기는 Org에서 별도로 관리하세요.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Salesforce 연결을 삭제하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  return <section className="workflow-panel settings-wide salesforce-panel connections-panel" aria-labelledby="salesforce-connections-heading">
    <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="cloud" /></span><div>
      <h2 id="salesforce-connections-heading">Salesforce 인증</h2>
      {data && <p>{data.localMode ? '현재 OS 계정의 Salesforce CLI 인증을 사용합니다.' : '현재 사용자에게만 연결을 저장합니다.'}</p>}
    </div><button type="button" className="button button-primary" disabled={!data || busy} onClick={() => { if (localLoginId === undefined) { setAlias(''); setLocalAlias(''); setMessage(''); } setAuthUrl(''); setError(''); setRegistrationOpen(true); }}>새 연결</button></div>
    {loadState === 'initial' && <div className="salesforce-load-state" role="status" aria-live="polite" aria-busy="true"><span className="salesforce-skeleton" />Salesforce 인증 정보를 불러오는 중……</div>}
    {loadState === 'error' && <div className="salesforce-load-error" role="alert"><span>{loadError}</span><button type="button" className="small-button" onClick={() => void refresh().catch(() => undefined)}>다시 시도</button></div>}
    {data && loadState !== 'initial' && <div className="salesforce-content" aria-busy={loadState === 'refreshing'}>
    {registrationOpen && <ConnectionDialog title="Salesforce 새 연결" busy={busy} onClose={() => { setRegistrationOpen(false); setAuthUrl(''); setError(''); }}>
    {data.localMode
      ? <>
        <div className="salesforce-guide"><p>서버에 설치된 Salesforce CLI 기본 OAuth로 로그인합니다.</p><p>헤드리스 서버에서는 SSH 터널에 콜백 포트도 추가하세요.</p><code>-L {data.callbackPort ?? 1717}:localhost:{data.callbackPort ?? 1717}</code></div>
        <form className="salesforce-form" onSubmit={(event) => void startLocalLogin(event)}>
          <div className="salesforce-fields">
          <label><span>연결 별칭</span><input required value={localAlias} maxLength={120} autoComplete="off" onChange={(event) => setLocalAlias(event.target.value)} disabled={busy || localLoginId !== undefined} /></label>
          <label><span>Salesforce 로그인 주소</span><input type="url" required value={instanceUrl} maxLength={512} list="sfud-salesforce-login-urls" onChange={(event) => setInstanceUrl(event.target.value)} disabled={busy || localLoginId !== undefined} /></label>
          <datalist id="sfud-salesforce-login-urls"><option value="https://login.salesforce.com" /><option value="https://test.salesforce.com" /></datalist>
          </div><div className="salesforce-actions"><button className="button button-primary" type="submit" disabled={busy || localLoginId !== undefined || !localAlias.trim()}>{localLoginId ? '브라우저 로그인 대기 중……' : '브라우저에서 Salesforce 로그인'}</button></div>
        </form>
        {localLoginUrl && <p className="salesforce-login-fallback">로그인 창이 열리지 않았다면 <a href={localLoginUrl} target="_blank" rel="noopener noreferrer">Salesforce 로그인 페이지 열기</a></p>}
      </>
      : <>
        <div className="salesforce-guide"><p>Salesforce 승인 후 연결은 이 서버에 로그인한 사용자 계정에 저장됩니다.</p></div>
        {data.oauth?.ready && <form className="salesforce-form" onSubmit={(event) => void startRemoteOAuth(event)}>
          <div className="salesforce-fields">
            <label><span>연결 별칭</span><input required value={alias} maxLength={120} autoComplete="off" onChange={(event) => setAlias(event.target.value)} disabled={busy} /></label>
            <label><span>Salesforce 로그인 주소</span><input type="url" required value={instanceUrl} maxLength={512} list="sfud-salesforce-login-urls-remote" onChange={(event) => setInstanceUrl(event.target.value)} disabled={busy} /></label>
            <datalist id="sfud-salesforce-login-urls-remote"><option value="https://login.salesforce.com" /><option value="https://test.salesforce.com" /></datalist>
          </div><div className="salesforce-actions"><button className="button button-primary" type="submit" disabled={busy || !alias.trim()}>{busy ? 'Salesforce로 이동 중……' : 'Salesforce 계정 연결'}</button></div>
        </form>}
        {data.oauth?.ready !== true && <p className="salesforce-feedback salesforce-feedback-error">
          {data.oauth?.reason === 'storage_unavailable'
            ? <>관리자가 <code>SFUD_TOKEN_SECRET</code>을 설정해야 사용자별 연결을 저장할 수 있습니다.</>
            : data.oauth?.reason === 'https_required'
              ? '브라우저 OAuth를 사용하려면 HTTPS 공개 주소가 필요합니다.'
              : '관리자가 Salesforce OAuth 앱과 공개 HTTPS 주소를 설정해야 브라우저 로그인을 사용할 수 있습니다.'}
        </p>}
        <details className="salesforce-guide salesforce-manual-registration"><summary>수동 SFDX 인증 URL 등록</summary>
        <div className="salesforce-manual-help">
          <p>PC의 Salesforce CLI에서 인증 URL을 가져와 등록하세요.</p>
          <ol>
            <li>Salesforce 로그인<code>sf org login web --alias my-org</code></li>
            <li>인증 URL을 복사해 아래에 입력<code>sf org auth show-sfdx-auth-url --target-org my-org</code></li>
          </ol>
          <p>샌드박스·My Domain은 로그인 명령에 <code>--instance-url 로그인주소</code>를 추가하세요.</p>
          <p>인증 URL에는 갱신 토큰이 포함됩니다. 다른 사람과 공유하지 마세요.</p>
        </div>
        <form className="salesforce-form" onSubmit={(event) => void register(event)}>
          <div className="salesforce-fields">
          <label><span>연결 별칭</span><input required value={alias} maxLength={120} autoComplete="off" onChange={(event) => setAlias(event.target.value)} disabled={busy} /></label>
          <label><span>SFDX 인증 URL</span><input type="password" required value={authUrl} maxLength={16384} autoComplete="new-password" spellCheck={false} onChange={(event) => setAuthUrl(event.target.value)} disabled={busy} /></label>
          </div><div className="salesforce-actions"><button className="button button-primary" type="submit" disabled={busy || data.storageStatus !== 'ready' || !authUrl || !alias.trim()}>{busy ? '연결 확인 중……' : '연결 등록 또는 재인증'}</button></div>
        </form>
        {data.storageStatus !== 'ready' && <p className="salesforce-feedback salesforce-feedback-error">관리자가 <code>SFUD_TOKEN_SECRET</code>을 설정해야 사용자별 Salesforce 인증 URL을 저장할 수 있습니다.</p>}
        </details>
      </>}
    {message && <p className="salesforce-feedback" role="status">{message}</p>}{error && <p className="salesforce-feedback salesforce-feedback-error" role="alert">{error}</p>}
    </ConnectionDialog>}
    <ConnectionTable label="Salesforce 연결 목록" emptyMessage="연결된 Salesforce Org가 없습니다."
      refreshing={loadState === 'refreshing'} disabled={busy} onRefresh={() => void refresh().catch(() => undefined)}
      rows={data.connections.map((connection) => ({
        id: connection.id,
        name: <><strong>{connection.alias}</strong><span className="connection-cell-secondary">Salesforce</span></>,
        target: <><span>{connection.username ?? '사용자 확인 필요'}</span><code className="connection-cell-secondary">{connection.orgId ?? 'Org ID 확인 필요'}</code></>,
        connected: connection.status === 'CONNECTED',
        status: connection.status === 'CONNECTED' ? '연결됨' : '재인증 필요',
        actions: data.localMode ? <span className="connection-cell-secondary">CLI에서 관리</span>
          : <button type="button" className="small-button" disabled={busy} onClick={() => void remove(connection)}>연결 해제</button>,
      }))} />
    {loadError && <p className="salesforce-feedback salesforce-feedback-error" role="alert">새로고침에 실패했습니다. 현재 표시된 연결은 마지막으로 불러온 정보입니다. {loadError}</p>}
    {!registrationOpen && <>{message && <p className="salesforce-feedback" role="status">{message}</p>}{error && <p className="salesforce-feedback salesforce-feedback-error" role="alert">{error}</p>}</>}
    </div>}
  </section>;
}
