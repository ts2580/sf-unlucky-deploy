import { useEffect, useState } from 'react';
import type { GitConnection } from '../../../src/api/git-contracts';
import type { GitCatalogPage } from '../../../src/api/git-project-contracts';
import { catalog, errorMessage } from './api';

export function GitRepositoryPicker({ connection, disabled, onSelect }: {
  connection: GitConnection; disabled: boolean; onSelect(path: string): void;
}) {
  const [namespace, setNamespace] = useState('');
  const [namespacePage, setNamespacePage] = useState<GitCatalogPage>({ namespaces: [], repositories: [] });
  const [page, setPage] = useState<GitCatalogPage>({ namespaces: [], repositories: [] });
  const [cursor, setCursor] = useState<string>();
  const [namespaceCursor, setNamespaceCursor] = useState<string>();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsNamespace = connection.provider === 'bitbucket';

  useEffect(() => {
    if (!needsNamespace) return;
    const controller = new AbortController();
    setBusy(true); setError('');
    catalog(connection.id, { ...(namespaceCursor === undefined ? {} : { cursor: namespaceCursor }) }, controller.signal)
      .then((result) => setNamespacePage((old) => ({ ...result,
        namespaces: namespaceCursor === undefined ? result.namespaces : [...old.namespaces, ...result.namespaces] })))
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [connection.id, needsNamespace, namespaceCursor]);

  useEffect(() => {
    if (needsNamespace && namespace === '') return;
    const controller = new AbortController();
    setBusy(true); setError('');
    catalog(connection.id, { ...(namespace === '' ? {} : { namespace }), ...(cursor === undefined ? {} : { cursor }), search: query }, controller.signal)
      .then(setPage).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [connection.id, needsNamespace, namespace, cursor, query]);

  return <div className="git-picker">
    {needsNamespace && <label>워크스페이스
      <select value={namespace} disabled={disabled || busy} onChange={(event) => { setNamespace(event.target.value); setCursor(undefined); setPage({ namespaces: [], repositories: [] }); }}>
        <option value="">선택하세요</option>{namespacePage.namespaces.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label>}
    {needsNamespace && namespacePage.nextCursor && <button className="small-button" type="button" disabled={disabled || busy}
      onClick={() => setNamespaceCursor(namespacePage.nextCursor)}>계정 더 보기</button>}
    {(!needsNamespace || namespace !== '') && <>
      <div className="git-search"><label>저장소 검색<input value={search} maxLength={200} disabled={disabled || busy}
        onChange={(event) => setSearch(event.target.value)} /></label>
        <button type="button" className="small-button" disabled={disabled || busy} onClick={() => { setCursor(undefined); setQuery(search); }}>검색</button></div>
      <div className="git-repository-list">{page.repositories.map((repository) => <button type="button" className="git-repository-option"
        key={repository.repositoryId} disabled={disabled || busy} onClick={() => onSelect(repository.repositoryPath)}>{repository.repositoryPath}</button>)}</div>
      {!busy && page.repositories.length === 0 && <p>이 페이지에 표시할 저장소가 없습니다.{page.nextCursor ? ' 다음 페이지를 확인하세요.' : ''}</p>}
      <div className="git-actions">{cursor && <button className="small-button" type="button" disabled={disabled || busy} onClick={() => setCursor(undefined)}>처음으로</button>}
        {page.nextCursor && <button className="small-button" type="button" disabled={disabled || busy} onClick={() => setCursor(page.nextCursor)}>다음 저장소</button>}</div>
    </>}
    {busy && <p role="status">저장소 확인 중……</p>}{error && <p className="settings-error" role="alert">{error}</p>}
  </div>;
}
