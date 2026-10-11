import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api-client';
import { DeploymentPresetListSchema, DeploymentPresetSummarySchema, ResolvedDeploymentPresetSchema, SaveDeploymentPresetSchema, type SaveDeploymentPreset, type DeploymentPresetSummary, type DeploymentSelection, type ResolvedDeploymentPreset } from '../../../src/api/deployment-preset-contracts';
export function DeploymentPresets({ selection, canSave, canApply, onApply }: { selection: DeploymentSelection; canSave: boolean; canApply: boolean; onApply: (value: ResolvedDeploymentPreset) => void }) {
  const latest = useRef({ fingerprint: JSON.stringify(selection), canApply });
  latest.current = { fingerprint: JSON.stringify(selection), canApply };
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [presets, setPresets] = useState<DeploymentPresetSummary[]>([]);
  const [id, setId] = useState(''); const [name, setName] = useState('');
  const [resolved, setResolved] = useState<ResolvedDeploymentPreset>();
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const reload = async () => { const result = await apiRequest<{ presets: DeploymentPresetSummary[] }>('/api/v1/deployment-presets', { responseSchema: DeploymentPresetListSchema }); if (alive.current) setPresets(result.presets); };
  useEffect(() => { void reload().catch(() => setMessage('저장 설정을 불러오지 못했습니다.')); }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '저장 설정 처리에 실패했습니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const load = async (prepare = false) => {
    const fingerprint = latest.current.fingerprint;
    const value = await apiRequest<ResolvedDeploymentPreset>(`/api/v1/deployment-presets/${encodeURIComponent(id)}/${prepare ? 'prepare' : 'resolve'}`, {
      ...(prepare ? { method: 'POST' as const, csrf: true } : {}), responseSchema: ResolvedDeploymentPresetSchema,
    });
    if (!alive.current || !latest.current.canApply || latest.current.fingerprint !== fingerprint) { if (alive.current) setMessage('선택이 변경되어 이전 불러오기 결과를 적용하지 않았습니다.'); return; }
    setResolved(value); setName(value.preset.name);
    if (value.selection !== undefined) onApply(value);
    setMessage(`배포 대상 ${value.selection?.components?.length ?? 0}개와 테스트 클래스 ${value.selection?.tests.length ?? 0}개를 불러왔습니다.`);
  };
  return <details className="workflow-panel deployment-settings-panel" aria-label="저장한 배포 설정" aria-busy={busy}>
    <summary>배포 설정 저장·불러오기</summary>
    <div className="deployment-settings-grid">
    <label><span>저장 설정</span><select value={id} disabled={busy} onChange={(event) => { setId(event.target.value); setResolved(undefined); setName(presets.find((item) => item.id === event.target.value)?.name ?? ''); }}><option value="">새 설정</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label><span>설정 이름</span><input value={name} maxLength={80} disabled={busy || !canSave} onChange={(event) => setName(event.target.value)} /></label>
    </div>
    <div className="deployment-settings-actions">
      <button className="button button-secondary" type="button" disabled={!id || busy || !canApply} onClick={() => void run(() => load())}>불러오기</button>
      {resolved?.preparationRequired && resolved.selection === undefined && <button className="button button-secondary" type="button" disabled={busy || !canSave || !canApply} onClick={() => void run(() => load(true))}>저장한 Git 소스 준비</button>}
      <button className="button button-secondary" type="button" disabled={busy || !canSave || !name.trim() || !selection.sourceId || !selection.targetId} onClick={() => void run(async () => {
        const result = await apiRequest<DeploymentPresetSummary, SaveDeploymentPreset>(`/api/v1/deployment-presets${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', csrf: true, body: { name, selection }, requestSchema: SaveDeploymentPresetSchema, responseSchema: DeploymentPresetSummarySchema });
        setId(result.id); await reload(); setMessage(`배포 대상 ${selection.components?.length ?? 0}개와 테스트 클래스 ${selection.tests.length}개를 저장했습니다.`);
      })}>{id ? '현재 설정으로 갱신' : '새 설정 저장'}</button>
      <button className="button button-secondary" type="button" disabled={!id || busy || !canSave} onClick={() => void run(async () => { await apiRequest(`/api/v1/deployment-presets/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true }); setId(''); setName(''); setResolved(undefined); await reload(); setMessage('저장 설정을 삭제했습니다.'); })}>삭제</button>
    </div>
    {message && <p role="status">{message}</p>}
    {resolved?.warnings.map((warning) => <p className="warning-note" key={warning}>{warning}</p>)}
  </details>;
}
