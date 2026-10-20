import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { GitConnection } from '../../../src/api/git-contracts';
import type { GitImport, GitRefsResponse } from '../../../src/api/git-project-contracts';
import type { WorkspaceSource } from '../../../src/api/workspace-contracts';
import { createImport, errorMessage as gitErrorMessage, importById, inspect as inspectGitRepository,
  providerNames, refs as gitRefs, selectImportProject } from '../git/api';
import { Icon } from '../components/Icon';

export interface GitBranchSourceHandle {
  prepare(metadataType: string, signal: AbortSignal): Promise<WorkspaceSource>;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

// Branch selection only reads refs. The comparison action explicitly starts imports.
export const GitBranchSource = forwardRef<GitBranchSourceHandle, {
  connection: GitConnection; side: 'source' | 'target'; canRun: boolean; metadataType: string;
  onBranchChange: (key: string | undefined) => void;
}>(function GitBranchSource({ connection, side, canRun, metadataType, onBranchChange }, ref) {
  const [branches, setBranches] = useState<GitRefsResponse['refs']>([]);
  const [branchInput, setBranchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<GitImport>();
  const [preparing, setPreparing] = useState(false);
  const [selectingProject, setSelectingProject] = useState(false);
  const version = useRef(0);
  const preparationSignal = useRef<AbortSignal | undefined>(undefined);
  const selectedBranch = branches.find((branch) => branch.name === branchInput);
  const branchOptionsId = side === 'source' ? 'git-branch-options' : 'target-git-branch-options';
  const headingId = `${side}-git-branch-heading`;

  useEffect(() => {
    const controller = new AbortController();
    const request = { provider: connection.provider, repositoryPath: connection.repositoryPath!, connectionId: connection.id };
    const load = async () => {
      setBranches([]); setBranchInput(''); setError(''); setLoading(true);
      try {
        const repository = await inspectGitRepository(request, controller.signal);
        const all: GitRefsResponse['refs'] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await gitRefs({ ...request, kind: 'branch', ...(cursor === undefined ? {} : { cursor }) }, controller.signal);
          all.push(...page.refs); cursor = page.nextCursor;
          if (cursor !== undefined && (cursors.has(cursor) || cursors.size >= 100)) break;
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        if (controller.signal.aborted) return;
        const unique = [...new Map(all.map((branch) => [branch.name, branch])).values()]
          .sort((left, right) => left.name.localeCompare(right.name));
        setBranches(unique);
        setBranchInput(unique.find((branch) => branch.name === repository.repository.defaultBranch)?.name ?? unique[0]?.name ?? '');
      } catch (cause) { if (!controller.signal.aborted) setError(gitErrorMessage(cause)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void load();
    return () => { controller.abort(); version.current++; };
  }, [connection]);

  useEffect(() => {
    onBranchChange(selectedBranch === undefined ? undefined : `${selectedBranch.name}\u0000${selectedBranch.commitSha}`);
  }, [selectedBranch?.name, selectedBranch?.commitSha, onBranchChange]);

  useEffect(() => {
    version.current++; setImported(undefined); setPreparing(false); setSelectingProject(false); setError('');
  }, [metadataType]);

  useImperativeHandle(ref, () => ({
    async prepare(type, signal) {
      if (!canRun || selectedBranch === undefined || loading || preparing) throw new Error('Git 브랜치를 선택하세요.');
      const currentVersion = ++version.current;
      preparationSignal.current = signal;
      const assertCurrent = () => {
        if (signal.aborted || currentVersion !== version.current) throw new DOMException('Aborted', 'AbortError');
      };
      setPreparing(true); setError(''); setImported(undefined);
      try {
        assertCurrent();
        let current = (await createImport({ provider: connection.provider, repositoryPath: connection.repositoryPath!,
          connectionId: connection.id, ref: { kind: 'branch', name: selectedBranch.name },
          expectedCommitSha: selectedBranch.commitSha, metadataType: type }, signal)).import;
        const deadline = Date.now() + 10 * 60_000;
        while (true) {
          assertCurrent(); setImported(current);
          if (current.status === 'READY' && current.source !== undefined) return current.source;
          if (!['QUEUED', 'FETCHING', 'SELECTING', 'MATERIALIZING'].includes(current.status)) {
            throw new Error(current.errorMessage ?? 'Git 코드를 가져오지 못했습니다. 다시 비교를 실행하세요.');
          }
          if (Date.now() >= deadline) throw new Error('Git 코드 가져오기 대기 시간이 초과되었습니다. 다시 비교를 실행하세요.');
          await waitForPoll(signal); assertCurrent();
          current = (await importById(current.id, signal)).import;
        }
      } finally {
        if (currentVersion === version.current) {
          setPreparing(false); preparationSignal.current = undefined;
          if (signal.aborted) setImported(undefined);
        }
      }
    },
  }));

  const chooseProject = async (root: string) => {
    if (!canRun || imported?.status !== 'SELECTING' || selectingProject) return;
    const currentVersion = version.current;
    setSelectingProject(true); setError('');
    try {
      await selectImportProject(imported.id, root, preparationSignal.current);
      if (currentVersion === version.current) setImported({ ...imported, status: 'MATERIALIZING' });
    } catch (cause) {
      if (currentVersion === version.current && !preparationSignal.current?.aborted) setError(gitErrorMessage(cause));
    } finally { if (currentVersion === version.current) setSelectingProject(false); }
  };

  return <section className="git-branch-source" aria-labelledby={headingId} aria-busy={loading}>
    <div><strong id={headingId} title={connection.repositoryPath}>{side === 'target' ? '타겟 · ' : '소스 · '}{providerNames[connection.provider]} · {connection.alias ?? connection.repositoryPath}</strong>
      <p>브랜치를 선택하세요. 아래 메타데이터 검색에서 타입을 선택하고 비교를 실행하면 Git 코드를 가져옵니다.</p></div>
    <label>{side === 'target' ? '타겟 브랜치 검색 및 선택' : '브랜치 검색 및 선택'}<input list={branchOptionsId} value={branchInput} autoComplete="off" spellCheck={false}
      disabled={!canRun || loading || preparing} onChange={(event) => {
        version.current++; setBranchInput(event.target.value); setImported(undefined); setError('');
      }} placeholder={loading ? '브랜치 검색 중……' : '브랜치 이름 입력'} />
      <datalist id={branchOptionsId}>{branches.filter((branch) => branch.name.toLocaleLowerCase().includes(branchInput.trim().toLocaleLowerCase()))
        .map((branch) => <option key={branch.name} value={branch.name} />)}</datalist>
    </label>
    {loading ? <p className="git-branch-loading" role="status" aria-live="polite"><Icon name="refresh" /><span>브랜치 검색 중……</span></p>
      : <p>{branches.length === 0 ? '사용 가능한 브랜치가 없습니다.' : `${branches.length}개 브랜치 · 입력하여 검색할 수 있습니다.`}</p>}
    {selectedBranch !== undefined && <p className="git-sha">현재 선택: <code>{selectedBranch.name}</code> · 고정할 커밋 <code>{selectedBranch.commitSha}</code></p>}
    {imported?.status === 'SELECTING' && <div className="git-roots"><p>가져올 Salesforce DX 프로젝트 루트를 선택하세요. 선택 후 비교를 계속합니다.</p>
      {imported.projectRoots.map((root) => <button className="small-button" type="button" key={root} disabled={selectingProject} onClick={() => void chooseProject(root)}>{root} 선택</button>)}</div>}
    {preparing && imported?.status !== 'SELECTING' && <p className="git-branch-loading" role="status"><Icon name="refresh" /><span>Git 코드 가져오는 중……</span></p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
});
