import { apiRequest } from '../api-client';
import { gitMetadataTypes } from '../../../src/api/git-metadata-types';
import { useEffect, useState } from 'react';
import type { GitConnection, GitProviderId, GitProvidersResponse } from '../../../src/api/git-contracts';
import type { GitRepositoryResponse, GitRefsResponse, GitImport } from '../../../src/api/git-project-contracts';
import { GitRepositoryPicker } from './GitRepositoryPicker';
import { createImport, errorMessage, inspect, providerNames, refs } from './api';

interface Draft { provider: GitProviderId; connectionId: string; repositoryPath: string; kind: 'branch' | 'tag' | 'commit'; name: string }
const empty: Draft = { provider: 'github', connectionId: '', repositoryPath: '', kind: 'branch', name: '' };
function readDraft(userId: string): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(`sfud:git-draft:${userId}`) ?? 'null') as Draft | null;
    if (value && ['github', 'gitlab', 'bitbucket'].includes(value.provider) && ['branch', 'tag', 'commit'].includes(value.kind)
      && typeof value.connectionId === 'string' && value.connectionId.length <= 100
      && typeof value.repositoryPath === 'string' && value.repositoryPath.length <= 2000
      && typeof value.name === 'string' && value.name.length <= 1024) return value;
  } catch { /* Storage may be disabled or contain a stale draft. */ }
  return empty;
}

export function GitImportDialog({ userId, canEdit, providers, connections, connected, reimport, onImported }: {
  userId: string; canEdit: boolean; providers: GitProvidersResponse['providers']; connections: GitConnection[];
  connected?: GitConnection; reimport?: GitImport; onImported(): void;
}) {
  const [draft, setDraft] = useState(() => readDraft(userId));
  const [repository, setRepository] = useState<GitRepositoryResponse['repository']>();
  const [refPage, setRefPage] = useState<GitRefsResponse>({ refs: [] });
  const [busy, setBusy] = useState(false);
  const [projectRoot, setProjectRoot] = useState('.');
  const [metadataType, setMetadataType] = useState('ApexClass');
  const selectedMetadataType = gitMetadataTypes.find((entry) => entry.name === metadataType.trim());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const provider = providers.find((candidate) => candidate.id === draft.provider);
  const connection = connections.find((candidate) => candidate.id === draft.connectionId && candidate.provider === draft.provider);
  const unavailable = draft.connectionId !== '' && (connection === undefined || connection.status !== 'ACTIVE' || !provider?.privateImport);
  const disabled = !canEdit || busy || !provider?.publicImport;
  const selectedRef = refPage.refs.find((ref) => ref.name === draft.name && ref.kind === draft.kind);
  const sha = draft.kind === 'commit' ? draft.name : selectedRef?.commitSha;

  useEffect(() => {
    // Keep only user input needed after authorization; credentials never enter a draft.
    try { sessionStorage.setItem(`sfud:git-draft:${userId}`, JSON.stringify({ ...draft,
      repositoryPath: /[?@#]/u.test(draft.repositoryPath) ? '' : draft.repositoryPath })); } catch { /* Optional storage. */ }
  }, [draft, userId]);
  useEffect(() => {
    if (connected === undefined) return;
    setDraft((old) => ({ ...old, provider: connected.provider, connectionId: connected.id,
      repositoryPath: connected.repositoryPath ?? old.repositoryPath }));
    setRepository(undefined); setRefPage({ refs: [] });
    setMessage('연결이 완료되었습니다. 저장소와 기준 커밋을 확인하세요.');
  }, [connected]);
  useEffect(() => {
    if (reimport === undefined) return;
    setMetadataType(reimport.metadataType ?? 'ApexClass');
    setDraft((old) => ({ provider: reimport.provider, repositoryPath: reimport.repositoryPath, kind: reimport.ref.kind,
      name: reimport.ref.name, connectionId: old.provider === reimport.provider ? old.connectionId : '' }));
    setRepository(undefined); setRefPage({ refs: [] }); setError('');
    setMessage('저장소를 다시 확인해 새 가져오기를 시작하세요. 이전 비교와 배포 자료는 유지됩니다.');
    document.getElementById('git-import-heading')?.scrollIntoView({ block: 'start' });
  }, [reimport]);

  const change = (patch: Partial<Draft>) => {
    setDraft((old) => ({ ...old, ...patch })); setRepository(undefined); setRefPage({ refs: [] }); setError(''); setMessage('');
  };
  const repositoryRequest = (repositoryPath: string) => ({ provider: draft.provider, repositoryPath,
    ...(draft.connectionId === '' ? {} : { connectionId: draft.connectionId }) });
  const loadRefs = async (info: GitRepositoryResponse['repository'], cursor?: string) => {
    if (draft.kind === 'commit') return;
    const response = await refs({ ...repositoryRequest(info.repositoryPath), kind: draft.kind, ...(cursor === undefined ? {} : { cursor }) });
    setRefPage((old) => ({ ...response, refs: cursor === undefined ? response.refs : [...old.refs, ...response.refs] }));
    if (cursor === undefined) setDraft((old) => ({ ...old,
      name: response.refs.find((ref) => ref.name === old.name)?.name
        ?? response.refs.find((ref) => ref.name === info.defaultBranch)?.name ?? response.refs[0]?.name ?? '' }));
  };
  const inspectRepository = async () => {
    if (disabled || unavailable) return;
    setBusy(true); setError(''); setMessage(''); setRepository(undefined); setRefPage({ refs: [] });
    try {
      const response = await inspect(repositoryRequest(draft.repositoryPath.trim()));
      await loadRefs(response.repository);
      setRepository(response.repository);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const importRepository = async () => {
    if (disabled || unavailable || selectedMetadataType === undefined || repository === undefined || sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await createImport({ ...repositoryRequest(repository.repositoryPath), ref: { kind: draft.kind, name: draft.name }, expectedCommitSha: sha, metadataType: selectedMetadataType.name });
      setMessage('가져오기를 시작했습니다. 아래에서 진행 상태를 확인하세요.'); onImported();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  const registerBranch = async () => {
    if (disabled || unavailable || repository === undefined || sha === undefined || draft.kind !== 'branch') return;
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest('/api/v1/git/registrations', { method: 'POST', csrf: true, body: {
        ...repositoryRequest(repository.repositoryPath), ref: { kind: 'branch', name: draft.name },
        expectedCommitSha: sha, projectRoot: projectRoot.trim(),
      } });
      setMessage('배포 브랜치를 등록했습니다. 비교 시작 시 자동으로 동기화합니다.'); onImported();
    } catch (cause) { setError(errorMessage(cause)); onImported(); }
    finally { setBusy(false); }
  };

  return <section className="workflow-panel settings-wide git-panel" aria-labelledby="git-import-heading">
    <div className="panel-heading"><div><h2 id="git-import-heading">Git 프로젝트 가져오기</h2><p>저장소의 커밋을 고정해 비교와 배포에 사용합니다.</p></div></div>
    <div className="git-form-grid">
      <label>Git 제공자<select value={draft.provider} disabled={!canEdit || busy} onChange={(event) => change({ provider: event.target.value as GitProviderId, connectionId: '', name: '' })}>
        {(['github', 'gitlab', 'bitbucket'] as const).map((id) => <option key={id} value={id}>{providerNames[id]}</option>)}
      </select></label>
      <label>접근 계정<select value={draft.connectionId} disabled={disabled} onChange={(event) => {
        const selected = connections.find((entry) => entry.id === event.target.value);
        change({ connectionId: event.target.value, name: '', ...(selected?.repositoryPath === undefined ? {} : { repositoryPath: selected.repositoryPath }) });
      }}>
        <option value="">공개 저장소 · 연결 없이 사용</option>
        {connections.filter((entry) => entry.provider === draft.provider).map((entry) => <option value={entry.id} key={entry.id}>{entry.displayName}{entry.status === 'ACTIVE' ? '' : ' · 재연결 필요'}</option>)}
        {draft.connectionId !== '' && connection === undefined && <option value={draft.connectionId}>이전 연결 · 다시 선택하세요</option>}
      </select></label>
    </div>
    {connection?.status === 'ACTIVE' && provider?.privateImport && connection.repositoryPath === undefined && <GitRepositoryPicker key={connection.id} connection={connection} disabled={disabled} onSelect={(repositoryPath) => change({ repositoryPath, name: '' })} />}
    {connection?.repositoryPath && <p>이 연결은 {connection.repositoryPath} 저장소에서만 사용할 수 있습니다.</p>}
    {unavailable && <p className="settings-error" role="alert">사용할 수 없는 연결입니다. 위에서 계정을 다시 연결하거나 접근 계정을 변경하세요.</p>}
    <div className="git-form-grid">
      <label className="git-wide">저장소 URL 또는 경로<input value={draft.repositoryPath} maxLength={2000} autoComplete="off" spellCheck={false}
        placeholder={draft.provider === 'gitlab' ? 'group/subgroup/project' : 'owner/repository'} disabled={disabled} onChange={(event) => change({ repositoryPath: event.target.value })} /></label>
      <label>기준 종류<select value={draft.kind} disabled={disabled} onChange={(event) => change({ kind: event.target.value as Draft['kind'], name: '' })}>
        <option value="branch">브랜치</option><option value="tag">태그</option><option value="commit">커밋 SHA</option></select></label>
      <div className="git-actions"><button className="button button-secondary" type="button" disabled={disabled || unavailable || !draft.repositoryPath.trim()}
        onClick={() => void inspectRepository()}>{busy ? '확인 중……' : '저장소 확인'}</button></div>
    </div>
    {repository && <div className="git-reference">
      {draft.kind === 'branch' && <>
        <label>DX 프로젝트 경로<input value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} disabled={disabled} placeholder="." /></label>
        <p>저장소 루트는 . 을 입력하세요. 등록 브랜치는 서버 재시작 후에도 유지되며 비교할 때 선택한 타입만 준비합니다.</p>
        <button type="button" className="button button-primary" disabled={disabled || unavailable || !sha || !projectRoot.trim()}
          onClick={() => void registerBranch()}>{busy ? '브랜치 준비 중……' : '배포 브랜치 등록'}</button>
      </>}
      <p><strong>{repository.repositoryPath}</strong> · {connection?.repositoryPath ? 'Git 접근 확인' : repository.private ? '비공개' : '공개'}</p>
      {draft.kind === 'commit' ? <label>전체 커밋 SHA<input value={draft.name} maxLength={40} disabled={disabled} autoComplete="off" spellCheck={false}
        onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value.toLowerCase() }))} /></label>
        : <><label>{draft.kind === 'branch' ? '브랜치 선택' : '태그 선택'}<select value={draft.name} disabled={disabled || !refPage.refs.length}
          onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))}>
          {refPage.refs.length === 0 && <option value="">사용 가능한 ref가 없습니다</option>}
          {refPage.refs.map((ref) => <option key={`${ref.kind}:${ref.name}`} value={ref.name}>{ref.name}</option>)}
        </select></label>
        {refPage.nextCursor && <button type="button" className="small-button" disabled={disabled} onClick={() => {
          setBusy(true); void loadRefs(repository, refPage.nextCursor).catch((cause) => setError(errorMessage(cause))).finally(() => setBusy(false));
        }}>ref 더 보기</button>}</>}
      <label>가져올 메타데이터 타입<input list="settings-git-metadata-types" value={metadataType} disabled={disabled}
        autoComplete="off" onChange={(event) => setMetadataType(event.target.value)} aria-invalid={selectedMetadataType === undefined} />
        <datalist id="settings-git-metadata-types">{gitMetadataTypes.map((entry) => <option key={entry.name} value={entry.name}>{entry.directoryName}</option>)}</datalist>
      </label>
      {sha && <p className="git-sha">고정할 커밋 <code>{sha}</code></p>}
      <button type="button" className="button button-primary" disabled={disabled || unavailable || selectedMetadataType === undefined || !sha || !/^[0-9a-f]{40}$/u.test(sha)}
        onClick={() => void importRepository()}>이 커밋 가져오기</button>
    </div>}
    {!canEdit && <p>VIEWER 역할은 Git 계정 연결과 가져오기를 실행할 수 없습니다.</p>}
    {provider && !provider.publicImport && <p>관리자가 Git 가져오기를 비활성화했습니다.</p>}
    {message && <p role="status">{message}</p>}{error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
