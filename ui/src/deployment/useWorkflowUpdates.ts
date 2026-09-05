import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from 'react';

import { getComparisonJob, type ComparisonJobResponse } from '../comparison/api';
import type { DeploymentJobResponse } from '../../../src/api/deployment-contracts';
import { getDeploymentJob } from './api';
import type { LiveStatus } from './DeploymentStatus';

interface WorkflowUpdatesInput {
  comparisonJob: ComparisonJobResponse | null;
  dryRunJob: DeploymentJobResponse | null;
  deploymentJob: DeploymentJobResponse | null;
  setComparisonJob: Dispatch<SetStateAction<ComparisonJobResponse | null>>;
  setDryRunJob: Dispatch<SetStateAction<DeploymentJobResponse | null>>;
  setDeploymentJob: Dispatch<SetStateAction<DeploymentJobResponse | null>>;
  workflowSelectionKey: string;
  dryRunSelectionKey: string;
  comparisonJobSelectionKeyRef: RefObject<string | null>;
  dryRunJobSelectionKeyRef: RefObject<string | null>;
  setError: Dispatch<SetStateAction<string>>;
}

interface WorkflowEventMessage {
  resource: 'comparison' | 'deployment';
  jobId: string;
  kind: string;
  status: string;
  updatedAt: string;
}

/** SSE와 polling 수명을 관리하고 선택이 바뀐 작업의 늦은 응답을 폐기한다. */
export function useWorkflowUpdates({
  comparisonJob, dryRunJob, deploymentJob,
  setComparisonJob, setDryRunJob, setDeploymentJob,
  workflowSelectionKey, dryRunSelectionKey,
  comparisonJobSelectionKeyRef, dryRunJobSelectionKeyRef, setError,
}: WorkflowUpdatesInput): LiveStatus {
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const workflowSelectionKeyRef = useRef(workflowSelectionKey);
  const dryRunSelectionKeyRef = useRef(dryRunSelectionKey);
  const comparisonJobRef = useRef(comparisonJob);
  const dryRunJobRef = useRef(dryRunJob);
  const deploymentJobRef = useRef(deploymentJob);
  workflowSelectionKeyRef.current = workflowSelectionKey;
  dryRunSelectionKeyRef.current = dryRunSelectionKey;
  comparisonJobRef.current = comparisonJob;
  dryRunJobRef.current = dryRunJob;
  deploymentJobRef.current = deploymentJob;

  useEffect(() => {
    const controller = new AbortController();
    const events = new EventSource('/api/v1/workflow/events');
    setLiveStatus('connecting');
    events.onopen = () => setLiveStatus('connected');
    events.onerror = () => setLiveStatus('reconnecting');
    const handleWorkflowEvent = (rawEvent: Event) => {
      if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== 'string') return;
      let event: WorkflowEventMessage;
      try {
        event = JSON.parse(rawEvent.data) as WorkflowEventMessage;
      } catch {
        return;
      }

      if (event.resource === 'comparison' && comparisonJobRef.current?.id === event.jobId) {
        const selectionKey = comparisonJobSelectionKeyRef.current;
        if (selectionKey === null || selectionKey !== workflowSelectionKeyRef.current) return;
        void getComparisonJob(event.jobId, controller.signal)
          .then((data) => {
            if (
              !controller.signal.aborted && comparisonJobRef.current?.id === event.jobId
              && comparisonJobSelectionKeyRef.current === selectionKey
              && workflowSelectionKeyRef.current === selectionKey
            ) setComparisonJob(data.job);
          })
          .catch(() => undefined);
        return;
      }

      if (event.resource !== 'deployment') return;
      if (dryRunJobRef.current?.id === event.jobId) {
        const selectionKey = dryRunJobSelectionKeyRef.current;
        if (selectionKey === null || selectionKey !== dryRunSelectionKeyRef.current) return;
        void getDeploymentJob(event.jobId, controller.signal)
          .then((data) => {
            if (
              !controller.signal.aborted && dryRunJobRef.current?.id === event.jobId
              && dryRunJobSelectionKeyRef.current === selectionKey
              && dryRunSelectionKeyRef.current === selectionKey
            ) setDryRunJob(data.job);
          })
          .catch(() => undefined);
      }
      if (deploymentJobRef.current?.id === event.jobId) {
        void getDeploymentJob(event.jobId, controller.signal)
          .then((data) => {
            if (!controller.signal.aborted && deploymentJobRef.current?.id === event.jobId) {
              setDeploymentJob(data.job);
            }
          })
          .catch(() => undefined);
      }
    };
    events.addEventListener('workflow', handleWorkflowEvent);
    return () => {
      controller.abort();
      events.removeEventListener('workflow', handleWorkflowEvent);
      events.close();
    };
  }, []);

  useEffect(() => {
    if (comparisonJob === null || !['QUEUED', 'RUNNING'].includes(comparisonJob.status)) return;
    const selectionKey = comparisonJobSelectionKeyRef.current;
    if (selectionKey === null) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      getComparisonJob(comparisonJob.id, controller.signal)
        .then((data) => {
          if (
            controller.signal.aborted
            || workflowSelectionKeyRef.current !== selectionKey
            || comparisonJobSelectionKeyRef.current !== selectionKey
            || data.job.id !== comparisonJob.id
          ) return;
          setComparisonJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : '비교 상태를 확인하지 못했습니다.');
        });
    }, 900);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [comparisonJob]);

  useEffect(() => {
    if (dryRunJob === null || !['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status)) return;
    const selectionKey = dryRunJobSelectionKeyRef.current;
    if (selectionKey === null) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      getDeploymentJob(dryRunJob.id, controller.signal)
        .then((data) => {
          if (
            controller.signal.aborted
            || dryRunSelectionKeyRef.current !== selectionKey
            || dryRunJobSelectionKeyRef.current !== selectionKey
            || data.job.id !== dryRunJob.id
          ) return;
          setDryRunJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : 'dry-run 상태를 확인하지 못했습니다.');
        });
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [dryRunJob]);

  useEffect(() => {
    if (deploymentJob === null || !['QUEUED', 'DEPLOYING'].includes(deploymentJob.status)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      getDeploymentJob(deploymentJob.id, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted && data.job.id === deploymentJob.id) setDeploymentJob(data.job);
        })
        .catch((caught: unknown) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          setError(caught instanceof Error ? caught.message : '배포 상태를 확인하지 못했습니다.');
        });
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [deploymentJob]);

  return liveStatus;
}
