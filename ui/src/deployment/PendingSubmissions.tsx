import { DeploymentConfirmation } from './DeploymentConfirmation';
import { useEffect, useState } from 'react';
import { apiRequest } from '../api-client';
import { DeploymentSubmissionLookupSchema, type DeploymentJobResponse } from '../../../src/api/deployment-contracts';
import { listPending, completePending, dismissPending, type PendingSubmission, settleRejectedPending } from './pending-submissions';
import { startDirectDeployment, startDryRun } from './api';
export function PendingSubmissions({ owner, canRetry, canDeploy, onFound }: { owner: string; canRetry: boolean; canDeploy: boolean; onFound: (job: DeploymentJobResponse) => void }) {
  const [records, setRecords] = useState<PendingSubmission[]>([]);
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [retryKey, setRetryKey] = useState('');
  const [retryRecord, setRetryRecord] = useState<PendingSubmission>();
  useEffect(() => {
    const refresh = () => { try { setRecords(listPending(owner)); } catch { setMessage('대기 요청 저장소를 읽지 못했습니다.'); } };
    refresh(); window.addEventListener('storage', refresh); window.addEventListener('sfud:pending-updated', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('sfud:pending-updated', refresh); };
  }, [owner]);
  const check = async (record: PendingSubmission, retry = false) => {
    if (retry && (record.body.expectedTargetIdentityFingerprint === undefined || record.target === undefined || record.source === undefined || (record.body.sourceId?.startsWith('org:') && record.body.expectedSourceIdentityFingerprint === undefined))) { setMessage('원래 요청의 대상 identity 증거가 없어 재시도를 차단했습니다. 원래 작업 결과를 조회하고 대상을 다시 확인하세요.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await apiRequest<{ state: 'FOUND' | 'UNCONFIRMED'; job?: DeploymentJobResponse }>(`/api/v1/deployment-submissions/${record.operation}/${encodeURIComponent(record.key)}`, { responseSchema: DeploymentSubmissionLookupSchema });
      if (result.job !== undefined) { completePending(owner, record.key, result.job.id); onFound(result.job); setMessage('원래 요청의 작업을 확인했습니다.'); return; }
      if (!retry) { setMessage('작업 생성 여부를 아직 확인하지 못했습니다. 원래 요청이 서버에서 처리 중일 수 있습니다. 새 키로 자동 재제출하지 않습니다.'); return; }
      const response = record.operation === 'direct' ? await startDirectDeployment(record.body, record.key) : await startDryRun(record.body, record.key);
      completePending(owner, record.key, response.job.id); onFound(response.job); setRetryKey(''); setRetryRecord(undefined);
    } catch (error) { if (retry) await settleRejectedPending(owner, record.key, error); setMessage(error instanceof Error ? error.message : '원래 요청 결과를 확인하지 못했습니다.'); }
    finally { setBusy(false); }
  };
  if (records.length === 0) return null;
  return <details className="workflow-panel deployment-settings-panel" open><summary>대기 요청과 확인한 작업 ({records.length})</summary>
    {retryRecord?.source !== undefined && retryRecord.target !== undefined && <DeploymentConfirmation open source={retryRecord.source} target={retryRecord.target}
      components={retryRecord.body.components ?? []} testLevel={retryRecord.body.testLevel ?? 'auto'} tests={retryRecord.body.tests ?? []} mode="direct" busy={busy}
      onCancel={() => setRetryRecord(undefined)} onConfirm={() => void check(retryRecord, true)} />}
    <p>응답을 받지 못한 요청은 선택 변경·로그아웃 이후에도 사용자별로 보존합니다.</p>
    {records.map((record) => <div key={record.key} className="deployment-pending-record"><p>{record.operation === 'direct' ? '실제 배포' : 'Dry-run'} · {record.body.sourceId} → {record.body.targetOrgId} · <time>{record.createdAt}</time></p>
      {record.jobId ? <div className="deployment-settings-actions"><a className="button button-secondary" href={`/deploy?job=${encodeURIComponent(record.jobId)}`}>확인한 작업 이어보기</a><button className="button button-secondary" type="button" onClick={() => dismissPending(owner, record.key)}>대기 목록에서 정리</button></div> : <>
        <div className="deployment-settings-actions"><button className="button button-secondary" type="button" disabled={busy} onClick={() => void check(record)}>원래 요청 결과 조회</button></div>
        <label className="deployment-retry-confirmation"><input type="checkbox" checked={retryKey === record.key} onChange={(event) => setRetryKey(event.target.checked ? record.key : '')} /><span>원래 입력과 동일한 제출 ID로 재시도합니다{record.operation === 'direct' ? ' (실제 배포 요청)' : ''}.</span></label>
        <div className="deployment-settings-actions"><button className="button button-secondary" type="button" disabled={busy || !canRetry || (record.operation === 'direct' && !canDeploy) || retryKey !== record.key} onClick={() => { if (record.operation === 'direct') { if (!record.source || !record.target || !record.body.expectedTargetIdentityFingerprint) setMessage('원래 대상 identity 증거가 없어 재시도를 차단했습니다. 원래 요청 결과를 조회하세요.'); else setRetryRecord(record); } else void check(record, true); }}>원래 요청 그대로 재시도</button></div>
      </>}
    </div>)}{message && <p role="status">{message}</p>}
  </details>;
}
