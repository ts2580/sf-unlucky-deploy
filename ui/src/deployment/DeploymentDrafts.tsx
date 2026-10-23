import { readClientDraft, saveClientDraft, removeClientDraft } from './client-draft';
import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '../api-client';
import { DeploymentDraftListSchema, DeploymentDraftSchema, ResolvedDeploymentDraftSchema, SaveDeploymentDraftSchema, type DeploymentDraft, type SaveDeploymentDraft } from '../../../src/contracts/deployment-draft-contracts';
import type { DeploymentSelection, ResolvedDeploymentPreset } from '../../../src/contracts/deployment-preset-contracts';
import { createIdempotencyKey } from './idempotency-key';

interface RecoverySelection { tabId: string; draftId?: string; selection?: DeploymentSelection }

/** Drafts preserve selections only. Server jobs, approvals and payloads remain independent. */
export function DeploymentDrafts({ owner, selection, enabled, autoSave, onApply }: { owner: string; selection: DeploymentSelection; enabled: boolean; autoSave: boolean; onApply: (value: ResolvedDeploymentPreset) => void }) {
  const [recovery, setRecovery] = useState<RecoverySelection>();
  const [checked, setChecked] = useState(false);
  const [tabId, setTabId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resolved, setResolved] = useState<ResolvedDeploymentPreset>();
  const latest = useRef({ fingerprint: JSON.stringify(selection), enabled });
  latest.current = { fingerprint: JSON.stringify(selection), enabled };
  const lastSavedFingerprint = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const version = useRef(0);
  const fingerprint = JSON.stringify(selection);

  useEffect(() => {
    alive.current = true;
    setChecked(false); setRecovery(undefined); setResolved(undefined); setMessage('');
    lastSavedFingerprint.current = undefined;
    const controller = new AbortController();
    let channel: BroadcastChannel | undefined;
    try {
      const key = `sfud:draft-tab:${owner}`;
      const previousTabId = sessionStorage.getItem(key);
      let stored = typeof BroadcastChannel === 'undefined' ? createIdempotencyKey() : previousTabId ?? createIdempotencyKey();
      sessionStorage.setItem(key, stored); setTabId(stored);
      // Duplicated browser tabs may copy sessionStorage. Negotiate a new tab identity.
      const nonce = createIdempotencyKey();
      channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(`sfud:draft-tabs:${owner}`);
      if (channel !== undefined) {
        channel.onmessage = (event: MessageEvent<{ kind: string; tabId: string; nonce: string }>) => {
          if (event.data?.tabId !== stored || event.data.nonce === nonce) return;
          if (event.data.kind === 'hello') channel?.postMessage({ kind: 'occupied', tabId: stored, nonce });
          else if (event.data.kind === 'occupied') { stored = createIdempotencyKey(); sessionStorage.setItem(key, stored); setTabId(stored); }
        };
        channel.postMessage({ kind: 'hello', tabId: stored, nonce });
      }
      const query = new URLSearchParams(window.location.search);
      const originalTab = query.get('restoreTab') ?? previousTabId ?? stored;
      const draftId = query.get('draft');
      // Only inspect selections from before this visit. Current edits save silently.
      const clientSelection = draftId ? undefined : readClientDraft(owner, originalTab);
      if (draftId || clientSelection !== undefined) {
        setRecovery({ tabId: originalTab, ...(draftId ? { draftId } : { selection: clientSelection }) });
        setChecked(true);
      } else {
        void apiRequest<{ drafts: DeploymentDraft[] }>('/api/v1/deployment-drafts', { signal: controller.signal, responseSchema: DeploymentDraftListSchema })
          .then(({ drafts }) => {
            if (controller.signal.aborted) return;
            const draft = drafts.find((item) => item.tabId === originalTab && Date.parse(item.expiresAt) > Date.now());
            if (draft !== undefined) setRecovery({ tabId: originalTab, draftId: draft.id });
          })
          .catch(() => { if (!controller.signal.aborted) setMessage('이전 작업 선택을 확인하지 못했습니다.'); })
          .finally(() => { if (!controller.signal.aborted) setChecked(true); });
      }
    } catch { setTabId(''); setChecked(true); setMessage('자동 저장을 사용할 수 없습니다. 브라우저 저장소 설정을 확인하세요.'); }
    return () => { alive.current = false; version.current++; controller.abort(); channel?.close(); };
  }, [owner]);

  useEffect(() => {
    if (autoSave && !busy && recovery !== undefined) {
      setRecovery(undefined); setResolved(undefined); setMessage('');
    }
  }, [autoSave, busy, recovery]);

  useEffect(() => {
    if (busy || !autoSave || !enabled || !tabId || !selection.sourceId || !selection.targetId || fingerprint === lastSavedFingerprint.current) return;
    try { saveClientDraft(owner, tabId, selection); } catch { setMessage('현재 선택을 브라우저에 임시 저장하지 못했습니다.'); }
    if (!checked || recovery !== undefined) return;
    const generation = ++version.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void apiRequest<DeploymentDraft, SaveDeploymentDraft>('/api/v1/deployment-drafts', { method: 'PUT', csrf: true, body: { tabId, selection }, signal: controller.signal, requestSchema: SaveDeploymentDraftSchema, responseSchema: DeploymentDraftSchema })
        .then(() => {
          if (!alive.current || generation !== version.current) return;
          lastSavedFingerprint.current = fingerprint;
          try { removeClientDraft(owner, tabId); } catch { /* Keep the fallback when storage is blocked. */ }
        })
        .catch((error: unknown) => { if (!controller.signal.aborted && alive.current && generation === version.current) setMessage(error instanceof Error ? error.message : '현재 선택을 자동 저장하지 못했습니다.'); });
    }, 700);
    return () => { clearTimeout(timer); controller.abort(); version.current++; };
  }, [fingerprint, tabId, enabled, autoSave, checked, recovery, owner, busy]);

  const clearReturnPath = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('draft'); url.searchParams.delete('restoreTab');
    window.history.replaceState(window.history.state, '', url);
  };
  const restore = async (prepare = false) => {
    if (recovery === undefined) return;
    const fingerprint = latest.current.fingerprint;
    setBusy(true); setMessage('');
    try {
      let draftId = recovery.draftId;
      if (!draftId && recovery.selection !== undefined) {
        if (recovery.selection.targetId.startsWith('org:') && recovery.selection.expectedTargetIdentityFingerprint === undefined) {
          throw new Error('저장 당시 Org를 확인할 수 없습니다. 대상을 다시 선택하세요.');
        }
        const draft = await apiRequest<DeploymentDraft, SaveDeploymentDraft>('/api/v1/deployment-drafts', { method: 'PUT', csrf: true, body: { tabId, selection: recovery.selection }, requestSchema: SaveDeploymentDraftSchema, responseSchema: DeploymentDraftSchema });
        draftId = draft.id;
        if (alive.current) setRecovery({ ...recovery, draftId });
      }
      const value = await apiRequest<{ draft: DeploymentDraft; resolved: ResolvedDeploymentPreset }>(`/api/v1/deployment-drafts/${encodeURIComponent(draftId!)}/${prepare ? 'prepare' : 'resolve'}`, { ...(prepare ? { method: 'POST' as const, csrf: true } : {}), responseSchema: ResolvedDeploymentDraftSchema });
      if (!alive.current || !latest.current.enabled || latest.current.fingerprint !== fingerprint) { if (alive.current) setMessage('선택이 변경되어 이전 작업 선택을 적용하지 않았습니다.'); return; }
      setResolved(value.resolved);
      if (value.resolved.selection !== undefined) {
        lastSavedFingerprint.current = value.draft.tabId === tabId ? JSON.stringify(value.resolved.selection) : undefined;
        onApply(value.resolved);
        try { removeClientDraft(owner, recovery.tabId); } catch { /* Storage may be blocked. */ }
        setRecovery(undefined); clearReturnPath();
      }
      setMessage(value.resolved.preparationRequired ? '이전 Git 소스를 준비한 뒤 복원할 수 있습니다.' : '이전 작업 선택을 복원했습니다. 다시 비교해 배포할 항목을 선택하세요.');
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : '이전 작업 선택을 복원하지 못했습니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const dismiss = () => {
    if (recovery === undefined) return;
    try { removeClientDraft(owner, recovery.tabId); } catch { /* Storage may be blocked. */ }
    setRecovery(undefined); setResolved(undefined); setMessage(''); clearReturnPath();
  };

  if (recovery === undefined && !message) return null;
  return <section className="deployment-recovery" aria-label="이전 작업 선택 복원" aria-busy={busy}>
    {recovery !== undefined && <>
      <p><strong>이전 작업 선택을 복원할까요?</strong> 소스·대상·비교·테스트 설정을 이어서 사용할 수 있습니다.</p>
      <div className="deployment-settings-actions">
        <button type="button" className="button button-secondary" disabled={!enabled || busy} onClick={() => void restore(resolved?.preparationRequired ?? false)}>{resolved?.preparationRequired ? 'Git 소스 준비 후 복원' : '이전 선택 복원'}</button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={dismiss}>닫기</button>
      </div>
    </>}
    {message && <p role="status">{message}</p>}
    {resolved?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
  </section>;
}
