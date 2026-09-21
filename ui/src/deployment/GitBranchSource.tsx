import { useEffect, useRef, useState } from 'react';
import { gitMetadataTypes } from '../../../src/api/git-metadata-types';
import type { GitConnection } from '../../../src/api/git-contracts';
import type { GitImport, GitRefsResponse } from '../../../src/api/git-project-contracts';
import type { WorkspaceSource } from '../../../src/api/workspace-contracts';
import { createImport, errorMessage as gitErrorMessage, importById, inspect as inspectGitRepository,
  providerNames, refs as gitRefs, selectImportProject } from '../git/api';

// Each side owns its selection, import polling and generation guard. Remount
// when changing repositories so a late response cannot replace another side.
export function GitBranchSource({ connection: selectedGitConnection, side, canRun, onSourceChange }: {
  connection: GitConnection; side: 'source' | 'target'; canRun: boolean;
  onSourceChange: (source: WorkspaceSource | undefined) => void;
}) {
  const [gitBranches, setGitBranches] = useState<GitRefsResponse['refs']>([]);
  const [gitBranchInput, setGitBranchInput] = useState('');
  const [gitMetadataType, setGitMetadataType] = useState('ApexClass');
  const selectedGitMetadataType = gitMetadataTypes.find((entry) => entry.name === gitMetadataType.trim());
  const [gitBranchLoading, setGitBranchLoading] = useState(false);
  const [gitBranchError, setGitBranchError] = useState('');
  const [gitImport, setGitImport] = useState<GitImport>();
  const [gitImportBusy, setGitImportBusy] = useState(false);
  const gitSelectionVersion = useRef(0);
  useEffect(() => () => { gitSelectionVersion.current++; }, []);
  const selectedGitBranch = gitBranches.find((branch) => branch.name === gitBranchInput);
  const branchOptionsId = side === 'source' ? 'git-branch-options' : 'target-git-branch-options';
  const typeOptionsId = side === 'source' ? 'git-metadata-type-options' : 'target-git-metadata-type-options';
  const headingId = `${side}-git-branch-heading`;
  useEffect(() => {
    if (selectedGitConnection === undefined) {
      setGitBranches([]);
      setGitBranchInput('');
      setGitBranchLoading(false);
      setGitBranchError('');
      return;
    }
    const controller = new AbortController();
    const request = { provider: selectedGitConnection.provider, repositoryPath: selectedGitConnection.repositoryPath!, connectionId: selectedGitConnection.id };
    const loadBranches = async () => {
      setGitBranches([]); setGitBranchInput(''); setGitBranchError(''); setGitBranchLoading(true);
      try {
        const repository = await inspectGitRepository(request, controller.signal);
        const branches: GitRefsResponse['refs'] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await gitRefs({ ...request, kind: 'branch', ...(cursor === undefined ? {} : { cursor }) }, controller.signal);
          branches.push(...page.refs);
          cursor = page.nextCursor;
          if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 100)) break;
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        if (controller.signal.aborted) return;
        const unique = [...new Map(branches.map((branch) => [branch.name, branch])).values()]
          .sort((left, right) => left.name.localeCompare(right.name));
        setGitBranches(unique);
        setGitBranchInput(unique.find((branch) => branch.name === repository.repository.defaultBranch)?.name ?? unique[0]?.name ?? '');
      } catch (cause) {
        if (!controller.signal.aborted) setGitBranchError(gitErrorMessage(cause));
      } finally { if (!controller.signal.aborted) setGitBranchLoading(false); }
    };
    void loadBranches();
    return () => controller.abort();
  }, [selectedGitConnection]);

  useEffect(() => {
    if (gitImport === undefined || !['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'].includes(gitImport.status)) return;
    let live = true;
    const version = gitSelectionVersion.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await importById(gitImport.id);
        if (!live || gitSelectionVersion.current !== version) return;
        setGitImport(response.import);
        if (response.import.status === 'READY' && response.import.source !== undefined) {
          onSourceChange(response.import.source);
        }
      } catch (cause) {
        if (live && gitSelectionVersion.current === version) setGitBranchError(gitErrorMessage(cause));
      }
      if (live && gitSelectionVersion.current === version) timer = setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => { live = false; if (timer !== undefined) clearTimeout(timer); };
  }, [gitImport?.id, gitImport?.status, onSourceChange]);

  const filteredGitBranches = gitBranches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(gitBranchInput.trim().toLocaleLowerCase()));
  const prepareGitBranch = async () => {
    if (!canRun || selectedGitConnection === undefined || selectedGitBranch === undefined || selectedGitMetadataType === undefined || gitImportBusy
      || ['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'].includes(gitImport?.status ?? '')) return;
    const version = ++gitSelectionVersion.current;
    onSourceChange(undefined);
    setGitImportBusy(true); setGitBranchError(''); setGitImport(undefined);
    try {
      const response = await createImport({ provider: selectedGitConnection.provider, repositoryPath: selectedGitConnection.repositoryPath!,
        connectionId: selectedGitConnection.id, ref: { kind: 'branch', name: selectedGitBranch.name }, expectedCommitSha: selectedGitBranch.commitSha, metadataType: selectedGitMetadataType.name });
      if (gitSelectionVersion.current !== version) return;
      setGitImport(response.import);
      if (response.import.status === 'READY' && response.import.source !== undefined) {
        onSourceChange(response.import.source);
      }
    } catch (cause) { if (gitSelectionVersion.current === version) setGitBranchError(gitErrorMessage(cause)); }
    finally { if (gitSelectionVersion.current === version) setGitImportBusy(false); }
  };
  const chooseGitProjectRoot = async (root: string) => {
    if (!canRun || gitImport === undefined || gitImportBusy) return;
    const version = gitSelectionVersion.current;
    setGitImportBusy(true); setGitBranchError('');
    try {
      await selectImportProject(gitImport.id, root);
      if (gitSelectionVersion.current === version) setGitImport({ ...gitImport, status: 'MATERIALIZING' });
    } catch (cause) { if (gitSelectionVersion.current === version) setGitBranchError(gitErrorMessage(cause)); }
    finally { if (gitSelectionVersion.current === version) setGitImportBusy(false); }
  };

  return (<section className="git-branch-source" aria-labelledby={headingId}>
              <div><strong id={headingId}>{side === 'target' ? '타겟 · ' : '소스 · '}{providerNames[selectedGitConnection.provider]} · {selectedGitConnection.repositoryPath}</strong><p>브랜치와 메타데이터 타입을 선택하면 해당 파일을 임시 작업공간에 가져옵니다.</p></div>
              <label>{side === 'target' ? '타겟 브랜치 검색 및 선택' : '브랜치 검색 및 선택'}<input list={branchOptionsId} value={gitBranchInput} autoComplete="off" spellCheck={false}
                disabled={!canRun || gitBranchLoading || gitImportBusy || ['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'].includes(gitImport?.status ?? '')} onChange={(event) => {
                  gitSelectionVersion.current++; setGitBranchInput(event.target.value); onSourceChange(undefined); setGitImport(undefined); setGitBranchError('');
                }} placeholder="브랜치 이름 입력" />
                <datalist id={branchOptionsId}>{filteredGitBranches.map((branch) => <option key={branch.name} value={branch.name} />)}</datalist>
              </label>
              <label>{side === 'target' ? '타겟 메타데이터 타입' : '가져올 메타데이터 타입'}<input list={typeOptionsId} value={gitMetadataType} autoComplete="off" spellCheck={false}
                disabled={!canRun || gitImportBusy || ['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'].includes(gitImport?.status ?? '')}
                onChange={(event) => {
                  gitSelectionVersion.current++; setGitMetadataType(event.target.value); onSourceChange(undefined); setGitImport(undefined); setGitBranchError('');
                }} placeholder="예: ApexClass, CustomField" aria-invalid={selectedGitMetadataType === undefined} />
                <datalist id={typeOptionsId}>{gitMetadataTypes.map((type) => <option key={type.name} value={type.name}>{type.directoryName}</option>)}</datalist>
              </label>
              {selectedGitMetadataType === undefined && <p className="settings-error">목록에서 가져올 메타데이터 타입을 선택하세요.</p>}
              {gitBranchLoading ? <p role="status">브랜치 목록을 불러오는 중……</p>
                : <p>{gitBranches.length === 0 ? '사용 가능한 브랜치가 없습니다.' : `${gitBranches.length}개 브랜치 · 입력하여 검색할 수 있습니다.`}</p>}
              {selectedGitBranch !== undefined && <p className="git-sha">현재 선택: <code>{selectedGitBranch.name}</code> · 고정할 커밋 <code>{selectedGitBranch.commitSha}</code></p>}
              {gitImport?.status === 'SELECTING' ? <div className="git-roots"><p>가져올 Salesforce DX 프로젝트 루트를 선택하세요.</p>
                {gitImport.projectRoots.map((root) => <button className="small-button" type="button" key={root} disabled={gitImportBusy} onClick={() => void chooseGitProjectRoot(root)}>{root} 선택</button>)}</div>
                : <button className="button button-secondary" type="button" disabled={!canRun || gitImportBusy || ['QUEUED', 'FETCHING', 'MATERIALIZING'].includes(gitImport?.status ?? '') || selectedGitBranch === undefined || selectedGitMetadataType === undefined || gitBranchLoading}
                  onClick={() => void prepareGitBranch()}>{gitImportBusy || ['QUEUED', 'FETCHING', 'MATERIALIZING'].includes(gitImport?.status ?? '') ? '브랜치 소스 준비 중……' : side === 'target' ? '이 브랜치로 타겟 준비' : '이 브랜치로 소스 준비'}</button>}
              {gitImport !== undefined && gitImport.status !== 'SELECTING' && <p role="status">{gitImport.status === 'READY' ? 'Git 파일을 가져왔습니다. 아래에서 메타데이터를 조회하세요.' : `Git 소스 ${gitImport.status}`}</p>}
              {gitImport?.errorMessage && <p className="settings-error" role="alert">{gitImport.errorMessage}</p>}
              {gitBranchError && <p className="settings-error" role="alert">{gitBranchError}</p>}
            </section>);
}
