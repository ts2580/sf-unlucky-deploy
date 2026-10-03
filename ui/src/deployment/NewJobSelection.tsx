import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api-client';
import { ResolvedDeploymentPresetSchema, type ResolvedDeploymentPreset } from '../../../src/api/deployment-preset-contracts';
export function NewJobSelection({ jobId, enabled, selectionFingerprint, onApply }: { jobId: string; enabled: boolean; selectionFingerprint: string; onApply: (value: ResolvedDeploymentPreset) => void }) {
  const [resolved, setResolved] = useState<ResolvedDeploymentPreset>(); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const latest = useRef({ enabled, selectionFingerprint }); latest.current = { enabled, selectionFingerprint };
  const alive = useRef(true); const attempted = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async (prepare = false) => {
    const fingerprint = latest.current.selectionFingerprint; setBusy(true);
    try {
      const value = await apiRequest<ResolvedDeploymentPreset>(`/api/v1/deployment-jobs/${encodeURIComponent(jobId)}/${prepare ? 'prepare-new-selection' : 'new-selection'}`, { ...(prepare ? { method: 'POST' as const, csrf: true } : {}), responseSchema: ResolvedDeploymentPresetSchema });
      if (!alive.current || !latest.current.enabled || latest.current.selectionFingerprint !== fingerprint) return;
      setResolved(value); if (value.selection !== undefined) onApply(value);
      setMessage(value.preparationRequired ? '원래 Git 설정을 확인했습니다. 새 작업용 소스는 직접 준비하세요.' : '원래 작업 설정을 재검증했습니다. 현재 비교에서 컴포넌트를 다시 선택하세요.');
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '원래 작업 설정을 복원하지 못했습니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => { if (enabled && !attempted.current) { attempted.current = true; void load(); } }, [enabled]);
  return <section className="workflow-panel" aria-label="원래 작업 설정으로 새 작업"><p role="status">{message || '원래 작업 설정을 확인하는 중……'}</p>
    {resolved?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
    {resolved?.preparationRequired && <button type="button" className="button button-secondary" disabled={!enabled || busy} onClick={() => void load(true)}>새 작업용 Git 소스 준비</button>}
  </section>;
}
