import { DeploymentConfirmation } from './DeploymentConfirmation';
import { useEffect, useRef, useState } from 'react';
import type { ApiUser } from '../auth/api';
import type { DeploymentJobResponse } from '../../../src/api/deployment-contracts';
import { getComparisonJob, type ComparisonJobResponse } from '../comparison/api';
import { ComparisonResultPanel } from '../comparison/ComparisonResult';
import { executeApprovedDeployment, getDeploymentJob, manuallyReconcileDeploymentJob, reconcileDeploymentJob } from './api';
import { DryRunLiveProgress, DryRunResultPanel } from './DeploymentStatus';
import { useWorkflowUpdates } from './useWorkflowUpdates';

/** A server job is viewed independently of editable selections and their invalidation effects. */
export function JobResume({ user, jobId, resource }: { user: ApiUser; jobId: string; resource: 'deployment' | 'comparison' }) {
  const [comparisonJob, setComparisonJob] = useState<ComparisonJobResponse | null>(null);
  const [dryRunJob, setDryRunJob] = useState<DeploymentJobResponse | null>(null);
  const [deploymentJob, setDeploymentJob] = useState<DeploymentJobResponse | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const comparisonJobSelectionKeyRef = useRef<string | null>(jobId);
  const dryRunJobSelectionKeyRef = useRef<string | null>(jobId);
  const liveStatus = useWorkflowUpdates({ comparisonJob, dryRunJob, deploymentJob, setComparisonJob, setDryRunJob, setDeploymentJob,
    workflowSelectionKey: jobId, dryRunSelectionKey: jobId, comparisonJobSelectionKeyRef, dryRunJobSelectionKeyRef, setError });
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (resource === 'comparison') setComparisonJob((await getComparisonJob(jobId, controller.signal)).job);
      else {
        const { job } = await getDeploymentJob(jobId, controller.signal);
        if (job.kind === 'DRY_RUN') setDryRunJob(job); else setDeploymentJob(job);
      }
    };
    void load().catch((caught: unknown) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '작업을 복원하지 못했습니다.'); });
    return () => controller.abort();
  }, [jobId, resource]);
  const canDeploy = ['DEPLOYER', 'ADMIN'].includes(user.role);
  const action = async (run: () => Promise<{ job: DeploymentJobResponse }>) => {
    setBusy(true); setError('');
    try { const { job } = await run(); if (job.kind === 'DRY_RUN') setDryRunJob(job); else setDeploymentJob(job); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '작업 상태를 확인하지 못했습니다.'); }
    finally { setBusy(false); setConfirmed(false); }
  };
  const job = deploymentJob ?? dryRunJob;
  return <div className="page-stack"><section className="workflow-panel">
    <h1>작업 이어보기</h1><p>작업 ID: <code>{jobId}</code></p>
    <p>서버에 저장된 작업을 조회합니다. 상태 복원은 새 배포를 제출하지 않습니다.</p>
    <a href="/runs">실행 기록에서 다른 작업 선택</a> · <a href={resource === 'deployment' ? `/deploy?fromJob=${encodeURIComponent(jobId)}` : '/deploy'}>{resource === 'deployment' ? '이 설정으로 새 작업' : '새 작업 선택'}</a>
    {error && <p role="alert">{error}</p>}
    {job !== null && <><p>{job.source.label} → {job.target.label} · {job.status}</p>
      <DryRunLiveProgress job={job} liveStatus={liveStatus} />
      <DryRunResultPanel job={job} canReconcile={canDeploy} reconciling={busy} onReconcile={(value) => action(() => reconcileDeploymentJob(value.id))} canManuallyReconcile={user.role === 'ADMIN'} manuallyReconciling={busy} onManualReconcile={(value, input) => action(() => manuallyReconcileDeploymentJob(value.id, input))} onSettings={(path) => window.location.assign(`${path ?? '/settings'}?return=${encodeURIComponent(`/deploy?job=${encodeURIComponent(jobId)}`)}`)} />
      {job.artifactsExpired && <p className="warning-note">이 작업의 artifact가 만료되었습니다. 자동으로 다시 가져오거나 배포하지 않습니다.</p>}
      {dryRunJob?.status === 'APPROVAL_PENDING' && !dryRunJob.artifactsExpired && canDeploy && <section aria-label="기존 검증 작업 배포 승인">
        <p>기존 검증 작업의 원래 payload를 {dryRunJob.target.label}에 실제 배포합니다. 서버가 대상 identity와 payload 유효성을 다시 검사합니다.</p>
        <button type="button" className="button button-danger" disabled={busy || !dryRunJob.payloadChecksum} onClick={() => setConfirmed(true)}>기존 검증 작업 배포 내용 확인</button>
        <DeploymentConfirmation open={confirmed} source={dryRunJob.source} target={dryRunJob.target}
          components={dryRunJob.components ?? []} testLevel={dryRunJob.testPlan?.level ?? 'auto'} tests={dryRunJob.testPlan?.tests ?? []}
          mode="validated" validation={{ status: dryRunJob.status, ...(dryRunJob.payloadChecksum === undefined ? {} : { checksum: dryRunJob.payloadChecksum }), ...(dryRunJob.updatedAt === undefined ? {} : { validatedAt: dryRunJob.updatedAt }) }} busy={busy}
          onCancel={() => setConfirmed(false)} onConfirm={() => void action(() => executeApprovedDeployment({ dryRunJobId: dryRunJob.id,
            payloadChecksum: dryRunJob.payloadChecksum, targetAlias: dryRunJob.target.id.slice(4), confirmation: '실제 배포' }))} />
      </section>}
    </>}
    {comparisonJob !== null && <ComparisonResultPanel job={comparisonJob} />}
  </section></div>;
}
