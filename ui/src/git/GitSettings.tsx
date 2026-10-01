import { GitRegisteredBranches } from './GitRegisteredBranches';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ApiUser } from '../auth/api';
import { GitConnectionResponseSchema, GitTokenInputSchema, GitEnvironmentResponseSchema,
  type GitConnection, type GitProvidersResponse, type GitProviderId, type GitTokenInput } from '../../../src/api/git-contracts';
import type { GitImport } from '../../../src/api/git-project-contracts';
import { apiRequest } from '../api-client';
import { connections, errorMessage, providerNames, providers } from './api';
import { GitImportDialog } from './GitImportDialog';
import { GitProjectList } from './GitProjectList';
import { Icon } from '../components/Icon';
import { ConnectionTable } from '../components/ConnectionTable';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { GitAliasEditor } from './GitAliasEditor';

const tokenHelp: Record<GitProviderId, string> = {
  github: 'Fine-grained PAT에서 가져올 저장소와 Contents: Read-only를 선택하세요. 전체 저장소 권한은 필요하지 않습니다.',
  gitlab: '저장소 단위 연결은 Fine-grained PAT의 Repository → Code → Download 또는 기존 PAT의 read_repository로 사용할 수 있습니다. 계정 목록 연결에는 별도 계정·프로젝트 API 읽기 권한이 필요합니다.',
  bitbucket: '저장소 단위 연결은 API Token의 read:repository:bitbucket으로 사용할 수 있습니다. 계정 목록 연결에는 read:user:bitbucket과 Atlassian 계정 이메일이 추가로 필요합니다. Repository/Project/Workspace Access Token은 현재 지원하지 않습니다.',
};

export function GitSettings({ user, section = 'projects' }: { user: ApiUser; section?: 'projects' | 'connections' }) {
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [configuration, setConfiguration] = useState<GitProvidersResponse>();
  const [accounts, setAccounts] = useState<GitConnection[]>([]);
  const [connected, setConnected] = useState<GitConnection>();
  const [provider, setProvider] = useState<GitProviderId>('github');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [expiry, setExpiry] = useState('');
  const [connectionMode, setConnectionMode] = useState<'repository' | 'account'>('repository');
  const [repositoryPath, setRepositoryPath] = useState('');
  const [replacement, setReplacement] = useState<GitConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loadState, setLoadState] = useState<'initial' | 'ready' | 'refreshing' | 'error'>('initial');
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [reimport, setReimport] = useState<GitImport>();
  const canEdit = user.role !== 'VIEWER';
  const ready = configuration?.providers.find((entry) => entry.id === provider)?.privateImport === true;
  const refresh = useCallback(async () => {
    setLoadState((current) => current === 'ready' ? 'refreshing' : 'initial');
    setLoadError('');
    try {
      const [options, result] = await Promise.all([providers(), connections()]);
      setConfiguration(options); setAccounts(result.connections); setLoadState('ready');
    } catch (cause) {
      setLoadError(errorMessage(cause));
      setLoadState((current) => current === 'initial' ? 'error' : current === 'refreshing' ? 'ready' : current);
      throw cause;
    }
  }, []);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || busy || !ready) return;
    // Secrets are cleared immediately, including when validation fails.
    setToken(''); setBusy(true); setError(''); setMessage('');
    try {
      if (connectionMode === 'repository' && repositoryPath.trim() === '') {
        throw new Error('연결할 저장소 URL을 입력하세요.');
      }
      const cleanToken = token.trim();
      if (cleanToken.length === 0 || cleanToken.length > 16384 || /[\s\u0000-\u001f\u007f]/u.test(cleanToken)) {
        throw new Error('토큰 원문만 입력하세요. 토큰 내부에 공백·줄바꿈이 포함되어 있습니다.');
      }
      const expiryDate = expiry === '' ? undefined : new Date(`${expiry}T23:59:59.999Z`);
      if (expiryDate !== undefined && (!Number.isFinite(expiryDate.getTime()) || expiryDate.getTime() <= Date.now())) {
        throw new Error('만료일은 오늘 이후의 올바른 날짜로 입력하세요.');
      }
      const body: GitTokenInput = { provider, token: cleanToken,
        ...(replacement ? { changeTarget: true } : {}),
        ...(connectionMode === 'repository' ? { repositoryPath: repositoryPath.trim() } : {}),
        ...(provider === 'bitbucket' && connectionMode === 'account' ? { apiUsername: email.trim() } : {}),
        ...(expiryDate === undefined ? {} : { expiresAt: expiryDate.toISOString() }) };
      const result = await apiRequest<{ connection: GitConnection }, GitTokenInput>(`/api/v1/git/connections${replacement ? `/${encodeURIComponent(replacement.id)}` : ''}`,
        { method: replacement ? 'PUT' : 'POST', csrf: true, body,
          requestSchema: GitTokenInputSchema, responseSchema: GitConnectionResponseSchema });
      setAccounts((old) => [...old.filter((entry) => entry.id !== result.connection.id), result.connection]);
      setConnected(result.connection); setReplacement(undefined); setEmail(''); setExpiry('');
      setMessage(`${providerNames[result.connection.provider]} ${result.connection.repositoryPath ? '저장소 연결' : '토큰'}을 등록했습니다.`);
      try { await refresh(); } finally { setRegistrationOpen(false); if (!result.connection.repositoryPath && !replacement) setImportOpen(true); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const disconnect = async (account: GitConnection) => {
    if (!canEdit || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest(`/api/v1/git/connections/${encodeURIComponent(account.id)}`, { method: 'DELETE', csrf: true });
      if (replacement?.id === account.id) { setReplacement(undefined); setToken(''); }
      setConnected(undefined); await refresh(); setRevision((value) => value + 1);
      setMessage(`${account.displayName} 연결을 삭제했습니다. 이미 준비된 소스와 배포 자료는 유지됩니다. 제공자에서 토큰 자체를 폐기하려면 해당 계정 설정을 사용하세요.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const importEnvironment = async () => {
    if (!canEdit || busy) return;
    setToken(''); setBusy(true); setError(''); setMessage('');
    try {
      const result = await apiRequest<{ results: { provider: GitProviderId; connection?: GitConnection; errorCode?: string }[] }>('/api/v1/git/connections/environment',
        { method: 'POST', csrf: true, timeoutMs: 75_000, responseSchema: GitEnvironmentResponseSchema });
      await refresh();
      const failures = result.results.filter((entry) => entry.errorCode !== undefined);
      setMessage(`환경변수 토큰 ${result.results.length - failures.length}개를 등록했습니다.`);
      if (failures.length === 0) setRegistrationOpen(false);
      if (failures.length) setError(`${failures.map((entry) => providerNames[entry.provider]).join(', ')} 토큰 검증에 실패했습니다. 환경변수의 토큰·이메일·권한을 확인하세요.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const closeRegistration = () => { setRegistrationOpen(false); setReplacement(undefined); setToken(''); setEmail(''); setExpiry(''); setError(''); };
  const editConnection = (account: GitConnection) => {
    if (!canEdit || busy) return;
    setRegistrationOpen(true); setMessage(''); setReplacement(account); setProvider(account.provider);
    setConnectionMode(account.repositoryPath ? 'repository' : 'account');
    setRepositoryPath(account.repositoryPath ?? ''); setToken(''); setEmail('');
    setExpiry(account.expiresAt?.slice(0, 10) ?? ''); setError('');
  };
  return <>
    {section === 'connections' && <section className="workflow-panel settings-wide git-panel connections-panel" aria-labelledby="git-connections-heading">
      <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="code" /></span><div><h2 id="git-connections-heading">Git 계정 연결</h2><p>저장소 URL과 PAT/API Token으로 접근을 확인하고 내 계정에 암호화하여 저장합니다.</p></div><button type="button" className="button button-primary" disabled={!configuration || !canEdit || busy} onClick={() => { setReplacement(undefined); setToken(''); setRepositoryPath(''); setEmail(''); setExpiry(''); setError(''); setMessage(''); setConnectionMode('repository'); setRegistrationOpen(true); }}>새 연결</button></div>
      {loadState === 'initial' && <p className="git-load-state" role="status" aria-live="polite" aria-busy="true">Git 제공자와 연결 정보를 불러오는 중……</p>}
      {loadState === 'error' && <div className="git-load-error" role="alert"><span>{loadError}</span><button type="button" className="small-button" onClick={() => void refresh().catch(() => undefined)}>다시 시도</button></div>}
      {configuration && <>
      {registrationOpen && <ConnectionDialog title={replacement ? 'Git 연결 설정' : 'Git 새 연결'} busy={busy} onClose={closeRegistration}>
      {replacement && <GitAliasEditor key={replacement.id} alias={replacement.alias} initiallyEditing
        endpoint={`/api/v1/git/connections/${encodeURIComponent(replacement.id)}/alias`} disabled={busy} onSaved={refresh} />}
      {replacement && !replacement.repositoryPath && <button type="button" className="small-button" disabled={busy || replacement.status !== 'ACTIVE'} onClick={() => { setConnected(replacement); closeRegistration(); setReimport(undefined); setImportOpen(true); }}>저장소 목록 조회</button>}
      <form onSubmit={(event) => void save(event)} className="git-token-form">
        <div className="git-form-grid">
          <label>연결 범위<select value={connectionMode} disabled={!canEdit || busy} onChange={(event) => {
            setConnectionMode(event.target.value as 'repository' | 'account'); setToken(''); setEmail(''); setError('');
          }}><option value="repository">저장소 하나 연결 (권장)</option><option value="account">계정으로 저장소 목록 조회</option></select></label>
          <label>토큰 제공자<select value={provider} disabled={!canEdit || busy} onChange={(event) => {
            setProvider(event.target.value as GitProviderId); setToken(''); setEmail(''); setExpiry(''); setRepositoryPath(''); setError('');
          }}>{(['github', 'gitlab', 'bitbucket'] as const).map((id) => <option value={id} key={id}>{providerNames[id]}</option>)}</select></label>
          {connectionMode === 'repository' && <label className="git-wide">연결할 저장소 URL<input required value={repositoryPath} maxLength={2000}
            autoComplete="off" spellCheck={false} placeholder={provider === 'gitlab' ? 'https://gitlab.com/group/project.git' : `https://${provider === 'github' ? 'github.com' : 'bitbucket.org'}/owner/repository.git`}
            disabled={!canEdit || busy || !ready} onChange={(event) => setRepositoryPath(event.target.value)} /></label>}
          <label>PAT / API Token<input type="password" required value={token} maxLength={16384} autoComplete="new-password" spellCheck={false}
            disabled={!canEdit || busy || !ready} onChange={(event) => setToken(event.target.value)} /></label>
          {provider === 'bitbucket' && connectionMode === 'account' && <label>Atlassian 계정 이메일<input type="email" required value={email} autoComplete="off" maxLength={254}
            disabled={!canEdit || busy || !ready} onChange={(event) => setEmail(event.target.value)} /></label>}
          <label>만료일<input type="date" value={expiry} disabled={!canEdit || busy || !ready} onChange={(event) => setExpiry(event.target.value)} /></label>
        </div>
        <p>{tokenHelp[provider]}</p><p>만료일은 선택 입력입니다. 토큰이 만료되거나 철회되면 새 토큰으로 교체하세요.</p>
        {connectionMode === 'repository' && <p>계정·워크스페이스 목록 조회 권한 없이 지정한 저장소만 확인합니다. 셀프호스팅 제공자는 포트와 /scm 같은 경로를 포함한 전체 HTTPS clone URL을 입력하세요. 공개 저장소는 토큰 없이도 접근되므로 계정 인증을 확인한 것으로 표시하지 않습니다.</p>}
        {replacement && <p role="status">{replacement.displayName}의 연결 대상을 변경하거나 재인증합니다. 새 대상에 접근할 토큰을 입력하세요. 검증에 실패하면 기존 연결을 유지합니다.</p>}
        <div className="git-actions"><button className="button button-primary" type="submit" disabled={!canEdit || busy || !ready || !token.trim() || (connectionMode === 'repository' && !repositoryPath.trim())}>
          {busy ? '검증 중……' : replacement ? '검증 후 설정 저장' : '토큰 검증 후 등록'}</button>
          {replacement && <button className="small-button" type="button" disabled={busy} onClick={closeRegistration}>교체 취소</button>}
          {configuration?.environmentAvailable && <button className="small-button" type="button" disabled={!canEdit || busy} onClick={() => void importEnvironment()}>환경변수 토큰 등록</button>}
        </div>
      </form>
      {message && <p role="status">{message}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
      </ConnectionDialog>}
      <ConnectionTable label="Git 연결 목록" emptyMessage="연결된 Git 계정이 없습니다. 새 연결을 등록하세요."
        refreshing={loadState === 'refreshing'} disabled={busy} onRefresh={() => void refresh().catch(() => undefined)}
        rows={accounts.map((account) => ({
          id: account.id,
          onEdit: () => editConnection(account),
          editDisabled: !canEdit || busy,
          name: <><strong>{account.alias ?? account.displayName}</strong><span className="connection-cell-secondary">{providerNames[account.provider]}</span></>,
          target: <><span>{account.repositoryPath ?? account.providerHost}</span><span className="connection-cell-secondary">{account.repositoryPath ? `${account.providerHost} · 저장소 연결` : '계정 연결'}</span></>,
          connected: account.status === 'ACTIVE',
          status: account.status === 'ACTIVE' ? '연결됨' : '토큰 교체 필요',
          ...(account.expiresAt ? { statusDetail: <span className="connection-cell-secondary">만료: <time dateTime={account.expiresAt}>{new Date(account.expiresAt).toLocaleDateString('ko-KR')}</time></span> } : {}),
          actions: <>
            <button type="button" className="small-button" disabled={!canEdit || busy || !configuration.providers.find((entry) => entry.id === account.provider)?.privateImport}
              onClick={() => editConnection(account)}>토큰 교체</button>
            <button type="button" className="small-button" disabled={!canEdit || busy} onClick={() => void disconnect(account)}>연결 삭제</button>
            {canEdit && <GitAliasEditor alias={account.alias} endpoint={`/api/v1/git/connections/${encodeURIComponent(account.id)}/alias`} disabled={busy} onSaved={refresh} />}
          </>,
        }))} />
      {!canEdit && <p>VIEWER 역할은 토큰을 등록하거나 변경할 수 없습니다.</p>}
      {loadState === 'refreshing' && <p className="git-load-refresh" role="status">Git 연결을 새로고침하는 중……</p>}
      {loadError && <p className="git-load-error" role="alert">새로고침에 실패했습니다. 마지막으로 불러온 연결을 표시합니다. {loadError}</p>}
      {!registrationOpen && <>{message && <p role="status">{message} <a href="/settings">Git 프로젝트 확인</a></p>}{error && <p className="settings-error" role="alert">{error}</p>}</>}
      </>}
    </section>}
    {section === 'projects' && <><section className="workflow-panel settings-wide git-panel git-import-launch" aria-labelledby="git-import-launch-heading">
      <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="folder" /></span><div><h2 id="git-import-launch-heading">Git 프로젝트 가져오기</h2><p>저장소의 커밋을 고정해 비교와 배포에 사용합니다.</p></div>
        <button className="button button-primary" type="button" disabled={!canEdit || !configuration?.providers.some((entry) => entry.publicImport)} onClick={() => setImportOpen(true)}><Icon name="plus" />프로젝트 가져오기</button></div>
    </section>
    <GitRegisteredBranches canEdit={canEdit} revision={revision} />
    <GitProjectList canEdit={canEdit} revision={revision} onReimport={(item) => { setReimport({ ...item }); setImportOpen(true); }} /></>}
    {importOpen && <GitImportDialog userId={user.id} canEdit={canEdit} providers={configuration?.providers ?? []} connections={accounts}
      connected={connected} reimport={reimport} onImported={(kind) => { setMessage(kind === 'import' ? '저장소 가져오기를 시작했습니다. 설정에서 Git 프로젝트의 진행 상태를 확인하세요.' : '배포 브랜치를 등록했습니다. 설정에서 등록 브랜치를 확인하세요.'); setRevision((value) => value + 1); setReimport(undefined); setImportOpen(false); }} onClose={() => { setReimport(undefined); setImportOpen(false); }} />}
  </>;
}
