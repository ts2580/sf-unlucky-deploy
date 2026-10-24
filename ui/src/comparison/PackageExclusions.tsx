import { useEffect, useRef, useState } from 'react';
import type { InstalledPackage, LoadedPackage, PackageComponent } from '../../../src/contracts/package-contracts';
import { apiRequest } from '../api-client';
import { Icon } from '../components/Icon';

export function PackageExclusions({ sourceIds, selectedIds, onChange }: {
  sourceIds: string;
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [members, setMembers] = useState<Record<string, PackageComponent[]>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const active = useRef<AbortController | null>(null);
  const selectedCount = packages.filter((entry) => selectedIds.includes(entry.id)).length;
  const availablePackages = packages.filter((entry) => entry.exclusionUnavailableReason === undefined);
  const unavailableCount = packages.length - availablePackages.length;
  const allSelected = availablePackages.length > 0 && availablePackages.every((entry) => selectedIds.includes(entry.id));
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setPackages([]);
    setMembers({});
    setFailures({});
    setProgress('');
    setStatus('loading');
    setError('');
    if (sourceIds) void listPackages(sourceIds, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setPackages(data.packages);
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(caught));
        setStatus('error');
      });
    return () => { controller.abort(); active.current?.abort(); };
  }, [sourceIds]);

  async function loadComponents() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setProgress('설치 패키지 목록 확인 중……');
    setError('');
    setFailures({});
    try {
      const data = await listPackages(sourceIds, controller.signal);
      if (controller.signal.aborted) return;
      setPackages(data.packages);
      setMembers({});
      setStatus('ready');
      const toLoad = data.packages.filter((entry) => entry.namespace === null
        || data.packages.some((other) => other.id !== entry.id && other.namespace === entry.namespace));
      let next = 0;
      let completed = 0;
      const running = new Map<string, string>();
      const showProgress = () => setProgress(`패키지 로딩 중…… ${completed}/${toLoad.length} 처리 · ${[...running.values()].join(', ')}`);
      const worker = async () => {
        while (!controller.signal.aborted) {
          const entry = toLoad[next++];
          if (entry === undefined) return;
          running.set(entry.id, entry.name);
          showProgress();
          try {
            const loaded = await apiRequest<LoadedPackage, { sourceIds: string[] }>(`/api/v1/installed-packages/${encodeURIComponent(entry.id)}/components`, {
              method: 'POST', csrf: true, body: { sourceIds: sourceIds.split(',') }, signal: controller.signal, timeoutMs: 1_400_000,
            });
            if (controller.signal.aborted) return;
            setPackages((current) => current.map((item) => item.id === entry.id ? loaded.package : item));
            setMembers((current) => ({ ...current, [entry.id]: loaded.components }));
          } catch (caught) {
            if (controller.signal.aborted) return;
            setFailures((current) => ({ ...current, [entry.id]: errorMessage(caught) }));
          } finally {
            running.delete(entry.id);
            completed++;
            if (!controller.signal.aborted) showProgress();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, toLoad.length) }, () => worker()));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(errorMessage(caught));
      setStatus('error');
    } finally { if (!controller.signal.aborted) setProgress(''); }
  }

  return <details className="package-exclusions">
    <summary className="option-toggle package-exclusions-summary">
      <span><strong>비교에서 제외할 설치 패키지</strong><small>{selectedIds.length > 0 ? `${selectedIds.length}개 패키지 제외` : '패키지를 선택해 비교에서 제외'}</small></span>
      <Icon name="chevron" />
    </summary>
    <fieldset className="package-exclusions-content" aria-label="비교에서 제외할 설치 패키지">
      {!sourceIds ? <p>Salesforce Org를 선택하면 설치 패키지를 확인할 수 있습니다.</p>
        : <>
          <div className="package-loading-actions">
            <button type="button" className={`button button-secondary${progress ? ' button-busy' : ''}`}
              disabled={status === 'loading' || !!progress} aria-busy={!!progress} onClick={() => void loadComponents()}>
              <Icon name="refresh" />{progress ? '패키지 로딩 중……' : '패키지 로딩'}
            </button>
            <label className={`option-toggle package-all-toggle${status !== 'ready' || !!progress || availablePackages.length === 0 ? ' option-toggle-disabled' : ''}`}>
              <span><strong>전체 제외</strong><small>{selectedCount}/{packages.length}개 선택</small></span>
              <input type="checkbox" aria-label="전체 패키지 제외" checked={allSelected}
                ref={(input) => { if (input) input.indeterminate = selectedCount > 0 && !allSelected; }}
                disabled={status !== 'ready' || !!progress || availablePackages.length === 0}
                onChange={(event) => onChange(event.target.checked ? availablePackages.map((entry) => entry.id).sort() : [])} /><i aria-hidden="true" />
            </label>
            <p>네임스페이스가 없거나 공유하는 패키지만 구성요소를 조회합니다. 고유 네임스페이스는 조회 없이 제외할 수 있습니다. 조회에는 수 분이 걸릴 수 있습니다.</p>
          </div>
          {status === 'ready' && unavailableCount > 0 && <p>전체 제외는 제외 가능한 {availablePackages.length}개 패키지만 선택합니다. 나머지 {unavailableCount}개는 패키지 로딩을 완료해 주세요.</p>}
          {progress && <p role="status">{progress}</p>}
          {status === 'loading' && <p role="status">설치 패키지 목록을 불러오는 중입니다.</p>}
          {error && <p role="alert">{error}</p>}
          {status === 'ready' && packages.length === 0 && <p>설치된 패키지가 없습니다.</p>}
          {status === 'ready' && <div className="package-exclusions-list">
            {packages.map((entry) => <div key={entry.id}>
              <label className={`option-toggle package-exclusion-item${entry.exclusionUnavailableReason !== undefined ? ' option-toggle-disabled' : ''}`}>
                <span><strong>{entry.name}</strong><small>{entry.namespace ?? '네임스페이스 없음'} · {entry.orgAliases.join(', ')}</small>
                  {entry.componentCount !== undefined && <small>구성요소 {entry.componentCount}개 로딩 완료</small>}
                  {entry.exclusionUnavailableReason && <small>{entry.exclusionUnavailableReason}</small>}</span>
                <input type="checkbox" aria-label={`${entry.name} 비교에서 제외`}
                  disabled={!!progress || entry.exclusionUnavailableReason !== undefined}
                  checked={selectedIds.includes(entry.id)} onChange={(event) => onChange(event.target.checked
                    ? [...selectedIds, entry.id].sort() : selectedIds.filter((id) => id !== entry.id))} /><i aria-hidden="true" />
              </label>
              {failures[entry.id] && <p role="alert">{entry.name}: {failures[entry.id]}</p>}
              {members[entry.id] && <PackageMembers name={entry.name} components={members[entry.id]!} />}
            </div>)}
          </div>}
        </>}
    </fieldset>
  </details>;
}

function PackageMembers({ name, components }: { name: string; components: PackageComponent[] }) {
  const [query, setQuery] = useState('');
  const matches = components.filter((member) => `${member.type}:${member.fullName}`.toLowerCase().includes(query.toLowerCase()));
  return <details className="package-members">
    <summary>{name} 구성요소 보기 ({components.length}개)</summary>
    <input aria-label={`${name} 구성요소 검색`} placeholder="유형 또는 이름 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
    <ul>{matches.slice(0, 200).map((member) => <li key={`${member.type}:${member.fullName}`}><code>{member.type}</code> · {member.fullName}</li>)}</ul>
    {matches.length > 200 && <p>{matches.length}개 중 200개 표시 · 검색어로 범위를 좁혀 주세요.</p>}
    {matches.length === 0 && <p>일치하는 구성요소가 없습니다.</p>}
  </details>;
}

function listPackages(sourceIds: string, signal: AbortSignal) {
  return apiRequest<{ packages: InstalledPackage[] }>(`/api/v1/installed-packages?sourceIds=${encodeURIComponent(sourceIds)}`, { signal, timeoutMs: 150_000 });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '패키지를 불러오지 못했습니다.'; }
