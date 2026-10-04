import { useEffect, useState } from 'react';
import type { InstalledPackage } from '../../../src/api/package-contracts';
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
  useEffect(() => {
    if (!sourceIds) return;
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    void apiRequest<{ packages: InstalledPackage[] }>(`/api/v1/installed-packages?sourceIds=${encodeURIComponent(sourceIds)}`,
      { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setPackages(data.packages);
        setStatus('ready');
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : '설치 패키지를 불러오지 못했습니다.');
        setStatus('error');
      });
    return () => controller.abort();
  }, [sourceIds]);

  return <details className="package-exclusions">
    <summary className="option-toggle package-exclusions-summary">
      <span><strong>비교에서 제외할 설치 패키지</strong><small>{selectedIds.length > 0 ? `${selectedIds.length}개 패키지 제외` : '패키지를 선택해 비교에서 제외'}</small></span>
      <Icon name="chevron" />
    </summary>
    <fieldset className="package-exclusions-content" aria-label="비교에서 제외할 설치 패키지">
      {!sourceIds ? <p>Salesforce Org를 선택하면 설치 패키지를 확인할 수 있습니다.</p>
        : <>
          {status === 'loading' && <p role="status">설치 패키지 목록을 불러오는 중입니다.</p>}
          {status === 'error' && <p role="alert">{error}</p>}
          {status === 'ready' && packages.length === 0 && <p>설치된 패키지가 없습니다.</p>}
          {status === 'ready' && <div className="package-exclusions-list">
            {packages.map((entry) => <label key={entry.id} className={`option-toggle package-exclusion-item${entry.exclusionUnavailableReason !== undefined ? ' option-toggle-disabled' : ''}`}>
              <span><strong>{entry.name}</strong><small>{entry.namespace ?? '네임스페이스 없음'} · {entry.orgAliases.join(', ')}</small>
                {entry.exclusionUnavailableReason && <small>{entry.exclusionUnavailableReason}</small>}</span>
              <input type="checkbox" aria-label={`${entry.name} 비교에서 제외`}
                disabled={entry.exclusionUnavailableReason !== undefined}
                checked={selectedIds.includes(entry.id)} onChange={(event) => onChange(event.target.checked
                  ? [...selectedIds, entry.id].sort() : selectedIds.filter((id) => id !== entry.id))} /><i aria-hidden="true" />
            </label>)}
          </div>}
        </>}
    </fieldset>
  </details>;
}
