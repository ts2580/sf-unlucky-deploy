import { readClientDraft, listClientDrafts, saveClientDraft, removeClientDraft } from './client-draft';
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api-client';
import { DeploymentDraftListSchema, DeploymentDraftSchema, ResolvedDeploymentDraftSchema, SaveDeploymentDraftSchema, type DeploymentDraft, type SaveDeploymentDraft } from '../../../src/api/deployment-draft-contracts';
import type { DeploymentSelection, ResolvedDeploymentPreset } from '../../../src/api/deployment-preset-contracts';
import { createIdempotencyKey } from './idempotency-key';
/** Drafts preserve selections only. Server jobs, approvals and payloads remain independent. */
export function DeploymentDrafts({ owner, selection, enabled, autoSave, onApply }: { owner: string; selection: DeploymentSelection; enabled: boolean; autoSave: boolean; onApply: (value: ResolvedDeploymentPreset) => void }) {
  const [drafts, setDrafts] = useState<DeploymentDraft[]>([]); const [message, setMessage] = useState('');
  const [id, setId] = useState(new URLSearchParams(window.location.search).get('draft') ?? ''); const [resolved, setResolved] = useState<ResolvedDeploymentPreset>();
  const [fallbacks, setFallbacks] = useState<{ tabId: string; selection: DeploymentSelection }[]>([]);
  const [fallbackTabId, setFallbackTabId] = useState('');
  const [clientDraft, setClientDraft] = useState<DeploymentSelection>();
  const [tabId, setTabId] = useState(''); const [busy, setBusy] = useState(false);
  const latest = useRef({ fingerprint: JSON.stringify(selection), enabled });
  latest.current = { fingerprint: JSON.stringify(selection), enabled };
  const lastSavedFingerprint = useRef<string | undefined>(undefined);
  const alive = useRef(true); const version = useRef(0);
  const fingerprint = JSON.stringify(selection);
  useEffect(() => {
    alive.current = true;
    try {
      const key = `sfud:draft-tab:${owner}`; let stored = typeof BroadcastChannel === 'undefined' ? createIdempotencyKey() : sessionStorage.getItem(key) ?? createIdempotencyKey();
      sessionStorage.setItem(key, stored); setTabId(stored);
      if (typeof BroadcastChannel === 'undefined') setMessage('탭 통신을 사용할 수 없어 새 탭 ID를 발급했습니다. 이전 초안은 목록에서 복원하세요.');
      // Duplicated browser tabs may copy sessionStorage. Negotiate a new tab identity.
      const nonce = createIdempotencyKey();
      const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(`sfud:draft-tabs:${owner}`);
      if (channel !== undefined) {
        channel.onmessage = (event: MessageEvent<{ kind: string; tabId: string; nonce: string }>) => {
          if (event.data?.tabId !== stored || event.data.nonce === nonce) return;
          if (event.data.kind === 'hello') channel.postMessage({ kind: 'occupied', tabId: stored, nonce });
          else if (event.data.kind === 'occupied') { stored = createIdempotencyKey(); sessionStorage.setItem(key, stored); setTabId(stored); }
        };
        channel.postMessage({ kind: 'hello', tabId: stored, nonce });
      }
      return () => { alive.current = false; version.current++; channel?.close(); };
    } catch { setMessage('탭 저장소를 사용할 수 없어 자동 초안 저장을 중단했습니다.'); return () => { alive.current = false; version.current++; }; }
  }, [owner]);
  useEffect(() => { if (tabId) { const originalTab = new URLSearchParams(window.location.search).get('restoreTab') ?? tabId; setFallbackTabId(originalTab); setClientDraft(readClientDraft(owner, originalTab)); setFallbacks(listClientDrafts(owner)); } }, [owner, tabId]);
  const reload = async () => { const data = await apiRequest<{ drafts: DeploymentDraft[] }>('/api/v1/deployment-drafts', { responseSchema: DeploymentDraftListSchema }); if (alive.current) setDrafts(data.drafts); };
  useEffect(() => { void reload().catch(() => { if (alive.current) setMessage('선택 초안을 불러오지 못했습니다.'); }); }, [owner]);
  useEffect(() => {
    if (!autoSave || !enabled || !tabId || !selection.sourceId || !selection.targetId || fingerprint === lastSavedFingerprint.current) return;
    try { saveClientDraft(owner, tabId, selection); setClientDraft(selection); setFallbackTabId(tabId); setFallbacks(listClientDrafts(owner)); } catch { setMessage('응답 전 선택 초안의 로컬 보관에 실패했습니다. 서버 저장 결과를 확인하세요.'); }
    const generation = ++version.current; const controller = new AbortController();
    const timer = setTimeout(() => {
      void apiRequest<DeploymentDraft, SaveDeploymentDraft>('/api/v1/deployment-drafts', { method: 'PUT', csrf: true, body: { tabId, selection }, signal: controller.signal, requestSchema: SaveDeploymentDraftSchema, responseSchema: DeploymentDraftSchema })
        .then(async () => { if (alive.current && generation === version.current) { lastSavedFingerprint.current = fingerprint; try { removeClientDraft(owner, tabId); setClientDraft(undefined); } catch { /* Keep the fallback when storage is blocked. */ } setMessage('현재 탭 선택 초안 저장됨 · 24시간 후 만료'); await reload(); } })
        .catch((error: unknown) => { if (!controller.signal.aborted && alive.current && generation === version.current) setMessage(error instanceof Error ? error.message : '선택 초안을 저장하지 못했습니다.'); });
    }, 700);
    return () => { clearTimeout(timer); controller.abort(); version.current++; };
  }, [fingerprint, tabId, enabled, autoSave]);
  const load = async (prepare = false) => {
    const fingerprint = latest.current.fingerprint;
    setBusy(true); setMessage('');
    try {
      const value = await apiRequest<{ draft: DeploymentDraft; resolved: ResolvedDeploymentPreset }>(`/api/v1/deployment-drafts/${encodeURIComponent(id)}/${prepare ? 'prepare' : 'resolve'}`, { ...(prepare ? { method: 'POST' as const, csrf: true } : {}), responseSchema: ResolvedDeploymentDraftSchema });
      if (!alive.current || !latest.current.enabled || latest.current.fingerprint !== fingerprint) { if (alive.current) setMessage('선택이 변경되어 이전 초안 복원 결과를 적용하지 않았습니다.'); return; }
      setResolved(value.resolved); if (value.resolved.selection !== undefined) { lastSavedFingerprint.current = JSON.stringify(value.resolved.selection); onApply(value.resolved); }
      setMessage(value.resolved.preparationRequired ? 'Git 소스를 명시적으로 준비한 뒤 선택을 복원하세요.' : '선택을 복원했습니다. 현재 소스를 다시 비교해 컴포넌트를 선택하세요.');
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '초안을 복원하지 못했습니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const restoreClientDraft = async () => {
    if (clientDraft === undefined) return;
    if (clientDraft.targetId.startsWith('org:') && clientDraft.expectedTargetIdentityFingerprint === undefined) { setMessage('원래 Org identity 증거가 없어 응답 전 초안을 복원할 수 없습니다. 대상을 다시 선택하세요.'); return; }
    const fingerprint = latest.current.fingerprint; setBusy(true);
    try {
      const draft = await apiRequest<DeploymentDraft, SaveDeploymentDraft>('/api/v1/deployment-drafts', { method: 'PUT', csrf: true, body: { tabId, selection: clientDraft }, requestSchema: SaveDeploymentDraftSchema, responseSchema: DeploymentDraftSchema });
      const result = await apiRequest<{ draft: DeploymentDraft; resolved: ResolvedDeploymentPreset }>(`/api/v1/deployment-drafts/${encodeURIComponent(draft.id)}/resolve`, { responseSchema: ResolvedDeploymentDraftSchema });
      if (!alive.current || !latest.current.enabled || latest.current.fingerprint !== fingerprint) return;
      setId(draft.id); setResolved(result.resolved);
      if (result.resolved.selection !== undefined) { lastSavedFingerprint.current = JSON.stringify(result.resolved.selection); onApply(result.resolved); }
      removeClientDraft(owner, fallbackTabId || tabId); setClientDraft(undefined); setFallbacks(listClientDrafts(owner)); await reload();
    } catch (error) { if (alive.current) setMessage(clientDraft.sourceId.startsWith('git:') || clientDraft.targetId.startsWith('git:') ? '응답 전 초안의 임시 Git 소스가 만료되었거나 준비할 수 없습니다. Git 소스를 다시 준비하세요. 자동으로 다시 가져오지 않습니다.' : error instanceof Error ? error.message : '응답 전 선택 초안을 재검증하지 못했습니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const attemptedReturnDraft = useRef(false);
  useEffect(() => {
    if (!enabled || attemptedReturnDraft.current || !new URLSearchParams(window.location.search).get('draft')) return;
    attemptedReturnDraft.current = true; void load();
  }, [enabled]);
  return <details className="workflow-panel deployment-settings-panel" open={new URLSearchParams(window.location.search).has('restoreTab') || undefined}><summary>탭별 선택 초안</summary><p>자동 저장한 Source·Target·비교·테스트 설정을 복원합니다. 컴포넌트와 승인 결과는 현재 비교에서 다시 선택합니다.</p>
    {fallbacks.length > 0 && <div className="deployment-settings-grid"><label className="deployment-settings-field-wide"><span>응답 전 선택 초안</span><select value={fallbackTabId} disabled={busy} onChange={(event) => { setFallbackTabId(event.target.value); setClientDraft(readClientDraft(owner, event.target.value)); }}><option value="">초안 선택</option>{fallbacks.map((fallback) => <option key={fallback.tabId} value={fallback.tabId}>{fallback.tabId === tabId ? '현재 탭' : `다른 탭 ${fallback.tabId.slice(0, 8)}`} · {fallback.selection.sourceId} → {fallback.selection.targetId}</option>)}</select></label></div>}
    {clientDraft !== undefined && <div className="deployment-settings-actions"><button className="button button-secondary" type="button" disabled={!enabled || busy} onClick={() => void restoreClientDraft()}>응답 전 선택 복원</button></div>}
    <div className="deployment-settings-grid">
    <label className="deployment-settings-field-wide"><span>선택 초안</span><select value={id} disabled={busy} onChange={(event) => { setId(event.target.value); setResolved(undefined); }}><option value="">초안 선택</option>{drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.tabId === tabId ? '현재 탭' : `다른 탭 ${draft.tabId.slice(0, 8)}`} · {draft.updatedAt}</option>)}</select></label>
    </div>
    <div className="deployment-settings-actions"><button type="button" className="button button-secondary" disabled={!enabled || !id || busy} onClick={() => void load()}>선택 초안 복원</button>
      {resolved?.preparationRequired && <button type="button" className="button button-secondary" disabled={!enabled || busy} onClick={() => void load(true)}>초안 Git 소스 준비</button>}
      <button type="button" className="button button-secondary" disabled={!enabled || !id || busy} onClick={() => { void apiRequest(`/api/v1/deployment-drafts/${encodeURIComponent(id)}`, { method: 'DELETE', csrf: true }).then(async () => { if (alive.current) { setId(''); setResolved(undefined); await reload(); } }).catch(() => setMessage('초안을 삭제하지 못했습니다.')); }}>초안 삭제</button></div>
    {message && <p role="status">{message}</p>}{resolved?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
  </details>;
}
