import { Value } from '@sinclair/typebox/value';
import { DeploymentSelectionSchema, type DeploymentSelection } from '../../../src/api/deployment-preset-contracts';
const prefix = 'sfud:draft-fallback:v1:';
interface ClientDraft { owner: string; tabId: string; expiresAt: string; selection: DeploymentSelection }
const keyFor = (owner: string, tabId: string) => `${prefix}${encodeURIComponent(owner)}:${tabId}`;
export function readClientDraft(owner: string, tabId: string): DeploymentSelection | undefined {
  try {
    const raw = localStorage.getItem(keyFor(owner, tabId)); if (raw === null || raw.length > 50_000) return;
    const value = JSON.parse(raw) as ClientDraft;
    if (value.owner !== owner || value.tabId !== tabId || typeof value.expiresAt !== 'string' || !(Date.parse(value.expiresAt) > Date.now()) || !Value.Check(DeploymentSelectionSchema, value.selection)) return;
    return value.selection;
  } catch { return; }
}
export function saveClientDraft(owner: string, tabId: string, selection: DeploymentSelection): void {
  if (!Value.Check(DeploymentSelectionSchema, selection)) return;
  const userPrefix = `${prefix}${encodeURIComponent(owner)}:`; let count = 0;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index); if (key === null || !key.startsWith(userPrefix)) continue;
    try { const value = JSON.parse(localStorage.getItem(key) ?? '{}') as ClientDraft; if (!(Date.parse(value.expiresAt) > Date.now())) { localStorage.removeItem(key); continue; } } catch { localStorage.removeItem(key); continue; }
    count++;
  }
  const key = keyFor(owner, tabId);
  if (localStorage.getItem(key) === null && count >= 20) throw new Error('응답 대기 초안이 20개입니다. 이전 탭 초안을 먼저 복원하세요.');
  localStorage.setItem(key, JSON.stringify({ owner, tabId, selection, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }));
}
export function removeClientDraft(owner: string, tabId: string): void { localStorage.removeItem(keyFor(owner, tabId)); }
export function listClientDrafts(owner: string): { tabId: string; selection: DeploymentSelection }[] {
  try {
    const result: { tabId: string; selection: DeploymentSelection }[] = [];
    const userPrefix = `${prefix}${encodeURIComponent(owner)}:`;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (key === null || !key.startsWith(userPrefix)) continue;
      const tabId = key.slice(userPrefix.length); const selection = readClientDraft(owner, tabId);
      if (selection !== undefined) result.push({ tabId, selection });
    }
    return result;
  } catch { return []; }
}
