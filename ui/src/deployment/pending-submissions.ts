import { WorkspaceSourceSchema, type WorkspaceSource } from '../../../src/api/workspace-contracts';
import { apiRequest } from '../api-client';
import { Value } from '@sinclair/typebox/value';
import { DeploymentSubmissionLookupSchema, type DeploymentJobResponse, CreateDirectDeploymentRequestSchema, CreateDryRunRequestSchema, type CreateDirectDeploymentRequest, type CreateDryRunRequest } from '../../../src/api/deployment-contracts';
const prefix = 'sfud:pending:v1:';
export interface PendingSubmission { owner: string; key: string; operation: 'dry-run' | 'direct'; body: CreateDryRunRequest | CreateDirectDeploymentRequest; wireFingerprint: string; createdAt: string; source?: WorkspaceSource; target?: WorkspaceSource; jobId?: string }
const storageKey = (owner: string, key: string) => `${prefix}${encodeURIComponent(owner)}:${encodeURIComponent(key)}`;
/** Each request has its own key: tabs never replace another tab's pending record. */
export function listPending(owner: string): PendingSubmission[] {
  const records: PendingSubmission[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key === null || !key.startsWith(`${prefix}${encodeURIComponent(owner)}:`)) continue;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw.length > 100_000) continue;
      const record = JSON.parse(raw) as PendingSubmission;
      if (record.owner !== owner || typeof record.key !== 'string' || record.key.length > 200 || !['dry-run', 'direct'].includes(record.operation)) continue;
      if (!Value.Check(record.operation === 'direct' ? CreateDirectDeploymentRequestSchema : CreateDryRunRequestSchema, record.body)) continue;
      if (record.wireFingerprint !== JSON.stringify(record.body)) continue;
      if (typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) continue;
      if (record.jobId !== undefined && (typeof record.jobId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/u.test(record.jobId))) continue;
      if (record.source !== undefined && !Value.Check(WorkspaceSourceSchema, record.source)) continue;
      if (record.target !== undefined && !Value.Check(WorkspaceSourceSchema, record.target)) continue;
      records.push(record);
    } catch { /* Corrupted records cannot become deployment requests. */ }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
export function persistPending(owner: string, operation: PendingSubmission['operation'], key: string, body: PendingSubmission['body'], source?: WorkspaceSource, target?: WorkspaceSource): PendingSubmission {
  if (!Value.Check(operation === 'direct' ? CreateDirectDeploymentRequestSchema : CreateDryRunRequestSchema, body)) throw new Error('요청 입력이 올바르지 않아 제출하지 않았습니다.');
  const existing = listPending(owner).find((item) => item.key === key);
  const wireFingerprint = JSON.stringify(body);
  if (existing !== undefined && (existing.wireFingerprint !== wireFingerprint || existing.operation !== operation)) throw new Error('원래 요청과 다른 설정으로 같은 제출 ID를 사용할 수 없습니다.');
  if (existing !== undefined) return existing;
  if (listPending(owner).length >= 50) throw new Error('대기 요청이 50개입니다. 이전 요청을 먼저 확인하세요.');
  const record: PendingSubmission = { owner, key, operation, body, wireFingerprint, ...(source === undefined ? {} : { source }), ...(target === undefined ? {} : { target }), createdAt: new Date().toISOString() };
  // A storage failure aborts submission before POST; unknown requests must not be lost.
  localStorage.setItem(storageKey(owner, key), JSON.stringify(record));
  window.dispatchEvent(new Event('sfud:pending-updated'));
  return record;
}
export function completePending(owner: string, key: string, _jobId: string): void {
  // Confirmed jobs live in server history; only unresolved submissions consume storage/quota.
  localStorage.removeItem(storageKey(owner, key));
  window.dispatchEvent(new Event('sfud:pending-updated'));
}
export function dismissPending(owner: string, key: string): void {
  localStorage.removeItem(storageKey(owner, key)); window.dispatchEvent(new Event('sfud:pending-updated'));
}

/** Transport ambiguity is preserved. A finished rejection is checked against server history. */
export async function settleRejectedPending(owner: string, key: string | null, error: unknown, allowClearFreshRequest = false): Promise<void> {
  if (!allowClearFreshRequest) return;
  if (key === null || typeof error !== 'object' || error === null || !('code' in error)) return;
  const code = typeof error.code === 'string' ? error.code : '';
  const status = 'status' in error ? error.status : undefined;
  if (code === 'CLIENT_SCHEMA_MISMATCH' || status === 401 || status === 403) { dismissPending(owner, key); return; }
  const rejectedCodes = ['INVALID_ARGUMENT', 'INVALID_DRY_RUN_REQUEST', 'INVALID_DIRECT_DEPLOYMENT_REQUEST', 'DIRECT_DEPLOYMENT_DENIED', 'ORG_IDENTITY_CHANGED', 'PROJECT_SELECTION_REQUIRED', 'DX_PROJECT_NOT_FOUND', 'REF_CHANGED', 'IMPORT_EXPIRED', 'GIT_CONNECTION_REQUIRED', 'CONNECTION_REAUTH_REQUIRED', 'SALESFORCE_AUTH_REQUIRED'];
  if (status !== 400 || !rejectedCodes.includes(code)) return;
  const record = listPending(owner).find((item) => item.key === key);
  if (record === undefined) return;
  try {
    const result = await apiRequest<{ state: 'FOUND' | 'UNCONFIRMED'; job?: DeploymentJobResponse }>(`/api/v1/deployment-submissions/${record.operation}/${encodeURIComponent(key)}`, { responseSchema: DeploymentSubmissionLookupSchema });
    if (result.job !== undefined) completePending(owner, key, result.job.id);
    else if (result.state === 'UNCONFIRMED') dismissPending(owner, key);
  } catch { /* Failed lookup cannot establish rejection; preserve the original request. */ }
}
