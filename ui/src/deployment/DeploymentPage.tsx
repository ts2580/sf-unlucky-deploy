import { gitMetadataTypes } from '../../../src/api/git-metadata-types';
import type { WorkspaceSource, WorkspaceResponse } from '../../../src/api/workspace-contracts';
import type { GitConnection } from '../../../src/api/git-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranchSource } from './GitBranchSource';

import { useWorkflowUpdates } from './useWorkflowUpdates';

import type {
  CreateDirectDeploymentRequest,
  CreateDryRunRequest,
  DeploymentJobResponse,
} from '../../../src/api/deployment-contracts';
import { ApiClientTimeoutError, apiRequest } from '../api-client';
import type { ApiUser } from '../auth/api';
import {
  startComparison,
  type ComparisonComponent,
  type ComparisonJobResponse,
} from '../comparison/api';
import { ComparisonResultPanel, WorkspaceSourceSelect } from '../comparison/ComparisonResult';
import { Icon } from '../components/Icon';
import { connections as getGitConnections, providerNames } from '../git/api';
import {
  executeApprovedDeployment,
  manuallyReconcileDeploymentJob,
  reconcileDeploymentJob,
  startDirectDeployment,
  startDryRun as requestDryRun,
} from './api';
import {
  DryRunLiveProgress,
  DryRunResultPanel,
  SubmissionProgress,
  WorkflowStatusPanel,
} from './DeploymentStatus';

type DryRunJobResponse = DeploymentJobResponse;
const gitConnectionSourcePrefix = 'git-connection:';



interface MetadataTypeOption {
  name: string;
  directoryName: string;
}

type MetadataTypesStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ApexTestClassCandidate {
  name: string;
  matchesConfiguredSuffix: boolean;
}

interface DeploymentCartItem {
  key: string;
  type: string;
  fullName: string;
}

function defaultMetadataType(metadataTypes: MetadataTypeOption[]): string {
  return metadataTypes.find((metadataType) => metadataType.name === 'ApexClass')?.name
    ?? metadataTypes[0]?.name
    ?? '';
}

function directTestSummary(testLevel: string, testCount: number): string {
  if (testLevel === 'RunSpecifiedTests') return `RunSpecifiedTests · ${testCount}개 · 75%`;
  if (testLevel === 'NoTestRun') return 'NoTestRun';
  if (testLevel === 'auto') return testCount > 0
    ? `자동 선택 · 지정 ${testCount}개 · 75%`
    : '자동 선택 · source 테스트 탐색';
  return `${testLevel} · Salesforce 구성 테스트`;
}

function directDeploymentDescription(testLevel: string, testCount: number): string {
  if (testLevel === 'NoTestRun') {
    return 'NoTestRun 배포 · 프로덕션 org에서 거부될 수 있습니다.';
  }
  if (testLevel === 'RunSpecifiedTests') {
    return testCount > 0
      ? '선택한 테스트 통과 · 커버리지 75% 이상 필요.'
      : '테스트 클래스를 하나 이상 선택하세요.';
  }
  if (testLevel === 'auto') {
    return 'Source 테스트 자동 선택 후 검증·배포합니다.';
  }
  return `${testLevel} · Salesforce 테스트 후 배포합니다.`;
}

export function DeploymentPage({ user }: { user: ApiUser }) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [gitConnections, setGitConnections] = useState<GitConnection[]>([]);
  const [gitConnectionsLoading, setGitConnectionsLoading] = useState(true);
  const [metadataTypes, setMetadataTypes] = useState<MetadataTypeOption[]>([]);
  const [metadataTypesStatus, setMetadataTypesStatus] = useState<MetadataTypesStatus>('idle');
  const [metadataTypesError, setMetadataTypesError] = useState('');
  const [scopeQuery, setScopeQuery] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceSelectionId, setSourceSelectionId] = useState('');
  const [preparedGitSource, setPreparedGitSource] = useState<WorkspaceSource>();
  const [targetOrgId, setTargetOrgId] = useState('');
  const [targetSelectionId, setTargetSelectionId] = useState('');
  const [preparedGitTarget, setPreparedGitTarget] = useState<WorkspaceSource>();
  const updateGitSource = useCallback((source: WorkspaceSource | undefined) => {
    setPreparedGitSource(source); setSourceId(source?.id ?? '');
  }, []);
  const updateGitTarget = useCallback((source: WorkspaceSource | undefined) => {
    setPreparedGitTarget(source); setTargetOrgId(source?.id ?? '');
  }, []);
  const [testLevel, setTestLevel] = useState('auto');
  const [tests, setTests] = useState('');
  const [showIdentical, setShowIdentical] = useState(false);
  const [compareCurrentType, setCompareCurrentType] = useState(true);
  const [comparisonSubmitting, setComparisonSubmitting] = useState(false);
  const [dryRunSubmitting, setDryRunSubmitting] = useState(false);
  const [deploymentSubmitting, setDeploymentSubmitting] = useState(false);
  const [reconcilingJobId, setReconcilingJobId] = useState<string | null>(null);
  const [manualReconcilingJobId, setManualReconcilingJobId] = useState<string | null>(null);
  const [comparisonJob, setComparisonJob] = useState<ComparisonJobResponse | null>(null);
  const [dryRunJob, setDryRunJob] = useState<DryRunJobResponse | null>(null);
  const [deploymentJob, setDeploymentJob] = useState<DryRunJobResponse | null>(null);
  const [deploymentCart, setDeploymentCart] = useState<DeploymentCartItem[]>([]);
  const [error, setError] = useState('');
  const [apexTestClasses, setApexTestClasses] = useState<ApexTestClassCandidate[]>([]);
  const [apexTestClassQuery, setApexTestClassQuery] = useState('');
  const [apexTestClassesLoading, setApexTestClassesLoading] = useState(false);
  const [apexTestClassesError, setApexTestClassesError] = useState('');
  const [testInputFocused, setTestInputFocused] = useState(false);
  const comparisonRequestControllerRef = useRef<AbortController | null>(null);
  const dryRunRequestControllerRef = useRef<AbortController | null>(null);
  const deploymentRequestControllerRef = useRef<AbortController | null>(null);
  const dryRunIdempotencyKeyRef = useRef<string | null>(null);
  const directDeploymentIdempotencyKeyRef = useRef<string | null>(null);
  const comparisonJobSelectionKeyRef = useRef<string | null>(null);
  const dryRunJobSelectionKeyRef = useRef<string | null>(null);
  const selectedGitConnection = gitConnections.find((connection) => `${gitConnectionSourcePrefix}${connection.id}` === sourceSelectionId);
  const selectedTargetGitConnection = gitConnections.find((connection) => `${gitConnectionSourcePrefix}${connection.id}` === targetSelectionId);
  const sourceMetadataType = (preparedGitSource?.id === sourceId ? preparedGitSource : workspace?.sources.find((entry) => entry.id === sourceId))?.provenance?.metadataType;
  const target = preparedGitTarget?.id === targetOrgId ? preparedGitTarget : workspace?.sources.find((entry) => entry.id === targetOrgId);
  const comparisonOnly = targetSelectionId.startsWith(gitConnectionSourcePrefix) || target?.location === 'git';
  const deploymentTargetValid = target?.kind === 'org' && targetOrgId.startsWith('org:') && !comparisonOnly;
  const targetMetadataType = compareCurrentType ? target?.provenance?.metadataType : undefined;
  const preparedMetadataType = sourceMetadataType ?? targetMetadataType;
  const metadataScopeMismatch = sourceMetadataType !== undefined && targetMetadataType !== undefined && sourceMetadataType !== targetMetadataType;
  const metadataTypeSourceIds = compareCurrentType ? `${sourceId},${targetOrgId}` : sourceId;
  const workflowSelectionKey = [
    sourceSelectionId, targetSelectionId,
    sourceId,
    compareCurrentType ? targetOrgId : '',
    scopeQuery,
    compareCurrentType ? showIdentical : false,
    compareCurrentType,
  ].join('\u0000');
  const deploymentSourceId = sourceId.startsWith('git-registered:')
    ? comparisonJob?.status === 'SUCCEEDED' && comparisonJobSelectionKeyRef.current === workflowSelectionKey
      && comparisonJob.right.id.startsWith('git:') ? comparisonJob.right.id : ''
    : sourceId;
  const comparisonLimitExceeded = comparisonJob?.result?.comparisonLimit?.exceeded === true;
  const cartSelectionKey = deploymentCart.map((item) => item.key).sort().join('\u0001');
  const dryRunSelectionKey = [sourceSelectionId, targetSelectionId, deploymentSourceId, targetOrgId, cartSelectionKey, testLevel, tests].join('\u0000');
  const workflowSelectionKeyRef = useRef(workflowSelectionKey);
  const dryRunSelectionKeyRef = useRef(dryRunSelectionKey);
  workflowSelectionKeyRef.current = workflowSelectionKey;
  dryRunSelectionKeyRef.current = dryRunSelectionKey;
  const liveStatus = useWorkflowUpdates({
    comparisonJob, dryRunJob, deploymentJob,
    setComparisonJob, setDryRunJob, setDeploymentJob,
    workflowSelectionKey, dryRunSelectionKey,
    comparisonJobSelectionKeyRef, dryRunJobSelectionKeyRef, setError,
  });
  const canRun = ['OPERATOR', 'DEPLOYER', 'ADMIN'].includes(user.role);
  const hasApexDeployment = deploymentCart.some((item) => item.type === 'ApexClass');

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<WorkspaceResponse>('/api/v1/workspace', { signal: controller.signal })
      .then((data) => {
        setWorkspace(data);
        const targetId = data.sources.find((source) => source.kind === 'org')?.id ?? '';
        setTargetOrgId(targetId);
        setTargetSelectionId(targetId);
        const initialSource = data.sources.find((source) => source.kind === 'local')?.id
          ?? data.sources.find((source) => source.id !== targetId)?.id
          ?? data.sources[0]?.id
          ?? '';
        setSourceId(initialSource);
        setSourceSelectionId(initialSource);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '작업 공간을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getGitConnections(controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setGitConnections(response.connections.filter((connection) => connection.repositoryPath !== undefined));
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        // Git connections are supplementary here. Keep comparison of existing sources available.
        if (!controller.signal.aborted) setGitConnections([]);
      })
      .finally(() => { if (!controller.signal.aborted) setGitConnectionsLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (sourceId.length === 0 || (compareCurrentType && targetOrgId.length === 0)) {
      setMetadataTypes([]);
      setScopeQuery('');
      setMetadataTypesStatus('idle');
      setMetadataTypesError('');
      return;
    }
    if (metadataScopeMismatch) {
      setMetadataTypes([]); setScopeQuery(''); setMetadataTypesStatus('error');
      setMetadataTypesError('소스와 타겟의 Git 메타데이터 타입을 동일하게 선택하고 다시 준비하세요.');
      return;
    }
    const preparedType = preparedMetadataType;
    if (preparedType !== undefined) {
      setMetadataTypes(gitMetadataTypes.filter((entry) => entry.name === preparedType));
      setScopeQuery(preparedType); setMetadataTypesStatus('ready'); setMetadataTypesError('');
      return;
    }
    const controller = new AbortController();
    setMetadataTypesStatus('loading');
    setMetadataTypesError('');
    apiRequest<{ metadataTypes: MetadataTypeOption[] }>(
      `/api/v1/metadata-types?sourceIds=${encodeURIComponent(metadataTypeSourceIds)}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setMetadataTypes(data.metadataTypes);
        setScopeQuery(defaultMetadataType(data.metadataTypes));
        setMetadataTypesStatus('ready');
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setMetadataTypes([]);
        setScopeQuery('');
        setMetadataTypesStatus('error');
        setMetadataTypesError(caught instanceof Error
          ? caught.message
          : 'Salesforce metadata type을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, [compareCurrentType, metadataTypeSourceIds, sourceId, targetOrgId, preparedMetadataType, metadataScopeMismatch]);

  useEffect(() => {
    comparisonRequestControllerRef.current?.abort();
    comparisonRequestControllerRef.current = null;
    comparisonJobSelectionKeyRef.current = null;
    setComparisonSubmitting(false);
    setComparisonJob(null);
  }, [workflowSelectionKey]);

  useEffect(() => {
    dryRunRequestControllerRef.current?.abort();
    deploymentRequestControllerRef.current?.abort();
    setDryRunSubmitting(false);
    setDeploymentSubmitting(false);
    dryRunIdempotencyKeyRef.current = null;
    directDeploymentIdempotencyKeyRef.current = null;
    dryRunJobSelectionKeyRef.current = null;
    setDryRunJob(null);
    setDeploymentJob(null);
  }, [dryRunSelectionKey]);

  useEffect(() => {
    if (dryRunJob !== null && !['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status)) {
      dryRunIdempotencyKeyRef.current = null;
    }
  }, [dryRunJob]);

  useEffect(() => {
    if (deploymentJob !== null && !['QUEUED', 'DEPLOYING'].includes(deploymentJob.status)) {
      directDeploymentIdempotencyKeyRef.current = null;
    }
  }, [deploymentJob]);

  useEffect(() => {
    setDeploymentCart([]);
  }, [sourceId, targetOrgId, sourceSelectionId, targetSelectionId]);

  useEffect(() => {
    if (deploymentSourceId.length === 0 || comparisonOnly) {
      setApexTestClasses([]);
      setApexTestClassQuery('');
      setApexTestClassesError('');
      setApexTestClassesLoading(false);
      return;
    }
    if (!hasApexDeployment && !testInputFocused) {
      setApexTestClassesLoading(false);
      return;
    }
    const controller = new AbortController();
    setApexTestClassQuery('');
    setApexTestClassesLoading(true);
    setApexTestClassesError('');
    apiRequest<{ testClasses: ApexTestClassCandidate[] }>(
      `/api/v1/apex-test-classes?sourceId=${encodeURIComponent(deploymentSourceId)}`, {
      signal: controller.signal,
    })
      .then((data) => {
        setApexTestClasses(data.testClasses);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setApexTestClassesError(caught instanceof Error
          ? caught.message
          : 'Apex 테스트 클래스 후보를 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setApexTestClassesLoading(false); });
    return () => controller.abort();
  }, [hasApexDeployment, deploymentSourceId, testInputFocused, comparisonOnly]);

  const source = preparedGitSource?.id === sourceId ? preparedGitSource : workspace?.sources.find((entry) => entry.id === sourceId);
  const comparing = comparisonSubmitting
    || (comparisonJob !== null && ['QUEUED', 'RUNNING'].includes(comparisonJob.status));
  const dryRunning = dryRunSubmitting
    || (dryRunJob !== null && ['QUEUED', 'DRY_RUN_RUNNING'].includes(dryRunJob.status));
  const deploying = deploymentSubmitting
    || (deploymentJob !== null && ['QUEUED', 'DEPLOYING'].includes(deploymentJob.status));
  const testNames = tests.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
  const selectedTestNames = new Set(testNames);
  const normalizedApexTestClassQuery = apexTestClassQuery.trim().toLocaleLowerCase();
  const filteredApexTestClasses = apexTestClasses.filter((testClass) =>
    testClass.name.toLocaleLowerCase().includes(normalizedApexTestClassQuery));
  const currentTestToken = tests.match(/[^\s,]*$/u)?.[0] ?? '';
  const normalizedCurrentTestToken = currentTestToken.toLocaleLowerCase();
  const directInputSuggestions = normalizedCurrentTestToken.length === 0
    ? []
    : apexTestClasses.filter((testClass) =>
      testClass.name.toLocaleLowerCase().includes(normalizedCurrentTestToken)
      && !selectedTestNames.has(testClass.name)).slice(0, 8);
  const directInputMatchesSource = apexTestClasses.some((testClass) =>
    testClass.name.toLocaleLowerCase() === normalizedCurrentTestToken);
  const directInputSearchOpen = testInputFocused
    && currentTestToken.length > 0
    && ['auto', 'RunSpecifiedTests'].includes(testLevel)
    && !directInputMatchesSource
    && (apexTestClassesLoading || apexTestClassesError.length > 0 || directInputSuggestions.length > 0);
  const testSelectionValid = testLevel !== 'RunSpecifiedTests' || testNames.length > 0;
  const selectedMetadataType = metadataTypes.find((entry) =>
    entry.name.toLowerCase() === scopeQuery.trim().toLowerCase());
  const scopeValid = selectedMetadataType !== undefined;
  const metadataTypesInvalid = metadataTypesStatus === 'error'
    || (metadataTypesStatus === 'ready' && !scopeValid);
  const canDeploy = ['DEPLOYER', 'ADMIN'].includes(user.role);
  const targetAlias = targetOrgId.startsWith('org:') ? targetOrgId.slice('org:'.length) : '';
  const changeTestLevel = (nextLevel: string) => {
    setTestLevel(nextLevel);
    if (!['auto', 'RunSpecifiedTests'].includes(nextLevel)) setTests('');
  };

  const setApexTestSelected = (testClass: string, selected: boolean) => {
    const next = new Set(testNames);
    if (selected) next.add(testClass);
    else next.delete(testClass);
    setTests([...next].sort((left, right) => left.localeCompare(right)).join(', '));
    if (selected && !['auto', 'RunSpecifiedTests'].includes(testLevel)) {
      setTestLevel('RunSpecifiedTests');
    }
  };

  const selectDirectTestClass = (testClass: string) => {
    const tokenStart = tests.search(/[^\s,]*$/u);
    setTests(`${tokenStart < 0 ? '' : tests.slice(0, tokenStart)}${testClass}`);
  };

  const setComponentInCart = (component: ComparisonComponent, selected: boolean) => {
    if (!deploymentTargetValid || component.status === 'REMOVED') return;
    setDeploymentCart((current) => {
      const remaining = current.filter((item) => item.key !== component.key);
      return selected
        ? [...remaining, { key: component.key, type: component.type, fullName: component.fullName }]
          .sort((left, right) => left.type.localeCompare(right.type) || left.fullName.localeCompare(right.fullName))
        : remaining;
    });
  };

  const runComparison = async () => {
    if (selectedMetadataType === undefined || metadataScopeMismatch || !sourceId || (compareCurrentType && !targetOrgId)) return;
    setError('');
    setComparisonJob(null);
    if (sourceId.startsWith('git-registered:')) setDeploymentCart([]);
    setComparisonSubmitting(true);
    const selectionKey = workflowSelectionKey;
    const controller = new AbortController();
    comparisonRequestControllerRef.current?.abort();
    comparisonRequestControllerRef.current = controller;
    comparisonJobSelectionKeyRef.current = selectionKey;
    try {
      const data = await startComparison({
          scope: 'all',
          metadataType: selectedMetadataType.name,
          ...(compareCurrentType ? { leftSourceId: targetOrgId } : { sourceOnly: true }),
          rightSourceId: sourceId,
          strict: false,
          showIdentical: compareCurrentType && showIdentical,
        }, controller.signal);
      if (
        controller.signal.aborted
        || workflowSelectionKeyRef.current !== selectionKey
        || comparisonJobSelectionKeyRef.current !== selectionKey
      ) return;
      setComparisonJob(data.job);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : '비교를 시작하지 못했습니다.');
    } finally {
      if (comparisonRequestControllerRef.current === controller) {
        comparisonRequestControllerRef.current = null;
        setComparisonSubmitting(false);
      }
    }
  };

  const startDryRun = async () => {
    if (!deploymentSourceId || !deploymentTargetValid || deploymentCart.length === 0 || !testSelectionValid) return;
    setError('');
    setDryRunJob(null);
    setDeploymentJob(null);
    const selectionKey = dryRunSelectionKey;
    const controller = new AbortController();
    dryRunRequestControllerRef.current?.abort();
    dryRunRequestControllerRef.current = controller;
    dryRunJobSelectionKeyRef.current = selectionKey;
    setDryRunSubmitting(true);
    try {
      const body: CreateDryRunRequest = {
        scope: 'selected',
        components: deploymentCart.map(({ type, fullName }) => ({ type, fullName })),
        sourceId: deploymentSourceId,
        targetOrgId,
        testLevel: testLevel as CreateDryRunRequest['testLevel'],
        tests: testNames,
        waitMinutes: 60,
        strict: false,
      };
      const idempotencyKey = dryRunIdempotencyKeyRef.current ?? crypto.randomUUID();
      dryRunIdempotencyKeyRef.current = idempotencyKey;
      const data = await requestDryRun(body, idempotencyKey, controller.signal);
      if (
        controller.signal.aborted
        || dryRunSelectionKeyRef.current !== selectionKey
        || dryRunJobSelectionKeyRef.current !== selectionKey
      ) return;
      setDryRunJob(data.job);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof ApiClientTimeoutError
        ? `${caught.message} dry-run을 다시 실행하면 같은 작업을 안전하게 찾습니다.`
        : caught instanceof Error ? caught.message : 'dry-run을 시작하지 못했습니다.');
    } finally {
      if (dryRunRequestControllerRef.current === controller) {
        dryRunRequestControllerRef.current = null;
        setDryRunSubmitting(false);
      }
    }
  };

  const executeDeployment = async () => {
    if (!deploymentSourceId || !deploymentTargetValid || !canDeploy || deploymentCart.length === 0 || !testSelectionValid) return;
    setError('');
    setDeploymentJob(null);
    const selectionKey = dryRunSelectionKey;
    const controller = new AbortController();
    deploymentRequestControllerRef.current?.abort();
    deploymentRequestControllerRef.current = controller;
    setDeploymentSubmitting(true);
    try {
      const approvedDryRun = dryRunJob?.status === 'APPROVAL_PENDING'
        && dryRunJob.payloadChecksum !== undefined;
      const directIdempotencyKey = approvedDryRun
        ? undefined
        : directDeploymentIdempotencyKeyRef.current ?? crypto.randomUUID();
      if (directIdempotencyKey !== undefined) {
        directDeploymentIdempotencyKeyRef.current = directIdempotencyKey;
      }
      const data = approvedDryRun
        ? await executeApprovedDeployment({
            dryRunJobId: dryRunJob.id,
            payloadChecksum: dryRunJob.payloadChecksum,
            targetAlias,
            confirmation: '실제 배포',
          }, controller.signal)
        : await startDirectDeployment({
            scope: 'selected',
            components: deploymentCart.map(({ type, fullName }) => ({ type, fullName })),
            sourceId: deploymentSourceId,
            targetOrgId,
            testLevel: testLevel as CreateDirectDeploymentRequest['testLevel'],
            tests: testNames,
            waitMinutes: 60,
            strict: false,
            targetConfirmation: targetAlias,
            confirmation: '실제 배포',
          }, directIdempotencyKey!, controller.signal);
      if (!controller.signal.aborted && dryRunSelectionKeyRef.current === selectionKey) {
        setDeploymentJob(data.job);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof ApiClientTimeoutError
        ? `${caught.message} 실제 배포를 다시 실행하면 이미 생성된 작업을 안전하게 찾습니다.`
        : caught instanceof Error ? caught.message : '실제 배포를 시작하지 못했습니다.');
    } finally {
      if (deploymentRequestControllerRef.current === controller) {
        deploymentRequestControllerRef.current = null;
        setDeploymentSubmitting(false);
      }
    }
  };

  const reconcileDeployment = async (job: DryRunJobResponse) => {
    if (!canDeploy || job.status !== 'RECONCILE_REQUIRED') return;
    setError('');
    setReconcilingJobId(job.id);
    try {
      const data = await reconcileDeploymentJob(job.id);
      if (data.job.kind === 'DRY_RUN') setDryRunJob(data.job);
      else setDeploymentJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Salesforce 상태를 재확인하지 못했습니다.');
    } finally {
      setReconcilingJobId(null);
    }
  };

  const manuallyReconcileDeployment = async (job: DryRunJobResponse, input: {
    deploymentId: string; operation: 'VALIDATE' | 'DEPLOY' | 'QUICK_DEPLOY'; observedAt: string; evidence: string;
  }) => {
    if (user.role !== 'ADMIN' || job.status !== 'RECONCILE_REQUIRED') return;
    setError('');
    setManualReconcilingJobId(job.id);
    try {
      const data = await manuallyReconcileDeploymentJob(job.id, input);
      if (data.job.kind === 'DRY_RUN') setDryRunJob(data.job);
      else setDeploymentJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '원격 ID를 연결하지 못했습니다.');
    } finally {
      setManualReconcilingJobId(null);
    }
  };

  const deploySources: WorkspaceSource[] = [
    ...(workspace?.sources ?? []).filter((source, index, sources) => {
      const provenance = source.provenance;
      if (source.location !== 'git' || provenance === undefined) return true;
      if (gitConnections.some((connection) => connection.status === 'ACTIVE' && connection.provider === provenance.provider
        && connection.providerHost === provenance.host && connection.repositoryPath === provenance.repositoryPath)) return false;
      return sources.findIndex((entry) => entry.provenance?.provider === provenance.provider
        && entry.provenance?.host === provenance.host && entry.provenance?.repositoryPath === provenance.repositoryPath) === index;
    }),
    ...gitConnections
      .filter((connection) => connection.status === 'ACTIVE' && connection.repositoryPath !== undefined)
      .map((connection) => ({
        id: `${gitConnectionSourcePrefix}${connection.id}`,
        kind: 'local' as const,
        location: 'git' as const,
        label: connection.repositoryPath!,
        detail: `${providerNames[connection.provider]} · 브랜치 선택`,
      })),
  ];
  useEffect(() => {
    const previous = workspace?.sources.find((entry) => entry.id === sourceSelectionId);
    const provenance = previous?.provenance;
    if (previous?.location !== 'git' || provenance === undefined) return;
    const connection = gitConnections.find((entry) => entry.status === 'ACTIVE' && entry.provider === provenance.provider
      && entry.providerHost === provenance.host && entry.repositoryPath === provenance.repositoryPath);
    if (connection !== undefined) {
      setSourceSelectionId(`${gitConnectionSourcePrefix}${connection.id}`);
      setSourceId('');
    }
  }, [workspace, gitConnections, sourceSelectionId]);
  useEffect(() => {
    const previous = workspace?.sources.find((entry) => entry.id === targetSelectionId);
    const provenance = previous?.provenance;
    if (previous?.location !== 'git' || provenance === undefined) return;
    const connection = gitConnections.find((entry) => entry.status === 'ACTIVE' && entry.provider === provenance.provider
      && entry.providerHost === provenance.host && entry.repositoryPath === provenance.repositoryPath);
    if (connection !== undefined) {
      setTargetSelectionId(`${gitConnectionSourcePrefix}${connection.id}`);
      setTargetOrgId(''); setPreparedGitTarget(undefined); setCompareCurrentType(true);
    }
  }, [workspace, gitConnections, targetSelectionId]);
  const selectDeploymentTarget = (value: string) => {
    setTargetSelectionId(value);
    setTargetOrgId(value.startsWith(gitConnectionSourcePrefix) ? '' : value);
    setPreparedGitTarget(undefined);
    if (value.startsWith(gitConnectionSourcePrefix) || workspace?.sources.find((entry) => entry.id === value)?.location === 'git') {
      setCompareCurrentType(true);
    }
  };
  const selectDeploymentSource = (value: string) => {
    setSourceSelectionId(value);
    setSourceId(value.startsWith(gitConnectionSourcePrefix) ? '' : value);
    setPreparedGitSource(undefined);
  };

  return (
    <div className="page-stack">
      <WorkflowStatusPanel
        liveStatus={liveStatus}
        comparisonJob={comparisonJob}
        deploymentJob={deploymentJob}
        deploymentSubmitting={deploymentSubmitting}
      />

      <header className="deployment-steps">
        <p className="eyebrow">COMPARE, SELECT, DEPLOY</p>
        <div className="stepper" aria-label="배포 단계"><span className="step-active"><i>1</i>검색</span><b /><span className={deploymentCart.length > 0 ? 'step-active' : ''}><i>2</i>배포 대상</span><b /><span className={dryRunJob !== null ? 'step-active' : ''}><i>3</i>Dry-run</span><b /><span className={deploymentJob !== null ? 'step-active' : ''}><i>4</i>배포</span></div>
      </header>

      <div className="deploy-layout">
        <div className="page-stack deploy-workspace">
          <section className="workflow-panel deploy-source-panel" aria-labelledby="deploy-source-heading">
            <div className="panel-heading"><span className="step-number">01</span><div><h2 id="deploy-source-heading">소스와 타겟</h2></div><span className="panel-state">{workspace === null ? '조회 중' : 'DEPLOY VIEW'}</span></div>
            <div className="deploy-source-grid">
              <WorkspaceSourceSelect side="DESIRED SOURCE" value={sourceSelectionId} sources={deploySources} onChange={selectDeploymentSource} tone="violet" />
              <div className="direction-marker"><span>{comparisonOnly ? '비교 대상' : '배포 대상'}</span><Icon name="arrow" /></div>
              <WorkspaceSourceSelect side="TARGET" value={targetSelectionId} sources={deploySources.filter((entry) => entry.kind === 'org' || entry.location === 'git')} onChange={selectDeploymentTarget} tone="blue" />
            </div>
            {gitConnectionsLoading && <p className="settings-message">등록된 Git 저장소를 불러오는 중……</p>}
            {selectedGitConnection !== undefined && <GitBranchSource key={`source-${selectedGitConnection.id}`}
              connection={selectedGitConnection} side="source" canRun={canRun} onSourceChange={updateGitSource} />}
            {selectedTargetGitConnection !== undefined && <GitBranchSource key={`target-${selectedTargetGitConnection.id}`}
              connection={selectedTargetGitConnection} side="target" canRun={canRun} onSourceChange={updateGitTarget} />}
            {comparisonOnly && <p className="warning-note" role="status">Git 타겟은 비교 전용입니다. Dry-run과 배포는 Salesforce org를 타겟으로 선택해야 합니다.</p>}
          </section>

          <section className="workflow-panel deploy-search-panel" aria-labelledby="deploy-scope-heading">
            <div className="panel-heading"><span className="step-number">02</span><div><h2 id="deploy-scope-heading">메타데이터 검색</h2></div><span className="panel-state">검색</span></div>
            <div className="compare-scope-grid metadata-scope-grid">
              <label><span className="field-label">Salesforce metadata type</span>
                <input id="deploy-scope" list="salesforce-deploy-metadata-types" value={scopeQuery} readOnly={preparedMetadataType !== undefined} onChange={(event) => setScopeQuery(event.target.value)} placeholder="metadata type 검색" autoComplete="off" disabled={metadataTypesStatus !== 'ready'} aria-invalid={metadataTypesInvalid ? true : undefined} />
                <datalist id="salesforce-deploy-metadata-types">
                  {metadataTypes.map((entry) => <option key={entry.name} value={entry.name}>{entry.directoryName}</option>)}
                </datalist>
              </label>
            </div>
            <p className={`field-hint${metadataTypesInvalid ? ' field-hint-error' : ''}`}><Icon name="check" />{
              metadataTypesStatus === 'idle'
                ? 'Source와 Target을 확인한 뒤 metadata type을 조회합니다.'
                : metadataTypesStatus === 'loading'
                  ? 'Salesforce metadata type을 불러오는 중입니다.'
                  : metadataTypesStatus === 'error'
                    ? metadataTypesError
                    : scopeValid
                      ? preparedMetadataType !== undefined
                        ? `${scopeQuery} 파일 준비 완료 · 다른 타입은 위에서 선택한 뒤 다시 가져오세요.`
                        : `${metadataTypes.length}개 metadata type 검색 가능 · ${compareCurrentType ? 'source와 target의 합집합' : 'source 기준'}`
                      : metadataTypes.length === 0
                        ? '사용 가능한 Salesforce metadata type이 없습니다.'
                        : '목록에 있는 Salesforce metadata type을 선택하세요.'
            }</p>
            <div className="comparison-controls-row">
              <OptionToggle title="현재 타입 비교 실행" description={comparisonLimitExceeded ? "파일 수 상한 초과로 비교를 생략합니다." : comparisonOnly ? "Git 타겟은 양쪽 비교만 지원합니다." : "끄면 Source 메타데이터만 받아옵니다."} disabled={comparisonOnly || comparisonLimitExceeded} checked={compareCurrentType && !comparisonLimitExceeded} onChange={(checked) => {
                setCompareCurrentType(checked);
                if (!checked) setShowIdentical(false);
              }} />
              <OptionToggle title="동일 항목 표시" description="IDENTICAL 컴포넌트도 결과에 포함" checked={showIdentical} onChange={setShowIdentical} disabled={!compareCurrentType || comparisonLimitExceeded} />
              <button className={`button button-secondary comparison-run-button${comparing ? ' comparison-run-loading' : ''}`} type="button" onClick={() => void runComparison()} disabled={!canRun || comparing || workspace === null || metadataTypesStatus !== 'ready' || !scopeValid || !sourceId || (compareCurrentType && (!targetOrgId || sourceId === targetOrgId))}><Icon name={comparing ? 'refresh' : 'compare'} /><span>{comparing ? '메타데이터 받는 중……' : '메타데이터 받아오기'}</span></button>
            </div>
          </section>

          {comparisonJob !== null && !['QUEUED', 'RUNNING'].includes(comparisonJob.status) && <ComparisonResultPanel
            job={comparisonJob}
            deploymentView
            selectedKeys={new Set(deploymentCart.map((item) => item.key))}
            onSelectionChange={setComponentInCart}
            selectionDisabled={!deploymentTargetValid || dryRunning || deploying}
            comparisonOnly={comparisonOnly}
          />}

          {!comparisonOnly && <section className="workflow-panel" aria-labelledby="test-heading">
            <div className="panel-heading"><span className="step-number">03</span><div><h2 id="test-heading">Apex 테스트 설정</h2></div><span className="auto-badge">{testLevel.toUpperCase()}</span></div>
            <div className="select-row">
              <label><span>테스트 수준</span><select value={testLevel} onChange={(event) => changeTestLevel(event.target.value)}><option value="auto">Auto · 권장</option><option value="RunSpecifiedTests">RunSpecifiedTests</option><option value="RunLocalTests">RunLocalTests</option><option value="RunAllTestsInOrg">RunAllTestsInOrg</option><option value="RunRelevantTests">RunRelevantTests</option><option value="NoTestRun">NoTestRun</option></select></label>
              <div
                className="test-class-input"
                onFocus={() => setTestInputFocused(true)}
                onBlur={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    setTestInputFocused(false);
                  }
                }}
              >
                <label><span>테스트 클래스 직접 입력</span><input
                  className="tests-input"
                  value={tests}
                  onChange={(event) => setTests(event.target.value)}
                  placeholder="AccountService_Test, Other_Test"
                  disabled={!['auto', 'RunSpecifiedTests'].includes(testLevel)}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={directInputSearchOpen}
                  aria-controls="source-apex-test-suggestions"
                /></label>
                {directInputSearchOpen && <div id="source-apex-test-suggestions" className="test-class-suggestions" role="listbox" aria-label="source 테스트 클래스 검색 결과">
                  <div className="test-class-suggestions-head"><span>{source?.label ?? 'source'}에서 검색</span><small>최대 8개</small></div>
                  {apexTestClassesLoading
                    ? <p><Icon name="refresh" />Apex 클래스 검색 중……</p>
                    : apexTestClassesError
                      ? <p className="test-class-suggestions-error">{apexTestClassesError}</p>
                      : directInputSuggestions.map((testClass) => <button key={testClass.name} type="button" role="option" aria-selected="false" onClick={() => selectDirectTestClass(testClass.name)}><Icon name="code" />{testClass.name}{testClass.matchesConfiguredSuffix && <small>접미사 일치</small>}</button>)}
                </div>}
              </div>
            </div>
            {hasApexDeployment
              ? <section className="apex-test-picker" aria-label="Apex 테스트 클래스 선택">
                <div className="apex-test-picker-head"><div><strong>Apex 테스트 클래스</strong><p>명명 규칙과 무관하게 desired source의 모든 Apex Class를 표시합니다. 실제 테스트 클래스만 선택하세요.</p></div><span>{testNames.length}개 선택</span></div>
                {apexTestClassesLoading
                  ? <p className="apex-test-message"><Icon name="refresh" />테스트 클래스 조회 중……</p>
                  : apexTestClassesError
                    ? <p className="apex-test-message apex-test-error">{apexTestClassesError} 직접 입력은 계속 사용할 수 있습니다.</p>
                    : apexTestClasses.length === 0
                      ? <p className="apex-test-message">Apex Class 후보가 없습니다. 필요한 클래스는 직접 입력하세요.</p>
                      : <>
                        <label className="apex-test-search"><span>테스트 클래스 검색</span><input value={apexTestClassQuery} onChange={(event) => setApexTestClassQuery(event.target.value)} placeholder="클래스 이름 검색" autoComplete="off" /><small>{filteredApexTestClasses.length} / {apexTestClasses.length}개 표시</small></label>
                        {filteredApexTestClasses.length === 0
                          ? <p className="apex-test-message">검색 조건과 일치하는 Apex Class가 없습니다.</p>
                          : <div className="apex-test-options">{filteredApexTestClasses.map((testClass) => <label key={testClass.name}><input type="checkbox" checked={selectedTestNames.has(testClass.name)} disabled={dryRunning || deploying || !['auto', 'RunSpecifiedTests'].includes(testLevel)} onChange={(event) => setApexTestSelected(testClass.name, event.target.checked)} /><span><Icon name="check" />{testClass.name}{testClass.matchesConfiguredSuffix && <small>접미사 일치</small>}</span></label>)}</div>}
                      </>}
              </section>
              : <p className="apex-test-empty"><Icon name="code" />Apex Class를 배포 대상에 추가하면 테스트 클래스 선택 목록을 불러옵니다.</p>}
            {!testSelectionValid && <p className="apex-test-validation" role="alert">RunSpecifiedTests는 테스트 클래스를 하나 이상 선택하거나 입력해야 합니다.</p>}
          </section>}

          {error && <section className="compare-error" role="alert"><strong>비교 및 배포 작업을 실행하지 못했습니다.</strong><p>{error}</p></section>}
          {dryRunJob !== null && <DryRunResultPanel job={dryRunJob} canReconcile={canDeploy} reconciling={reconcilingJobId === dryRunJob.id} onReconcile={reconcileDeployment} canManuallyReconcile={user.role === 'ADMIN'} manuallyReconciling={manualReconcilingJobId === dryRunJob.id} onManualReconcile={manuallyReconcileDeployment} />}
          {deploymentJob !== null && <DryRunResultPanel job={deploymentJob} canReconcile={canDeploy} reconciling={reconcilingJobId === deploymentJob.id} onReconcile={reconcileDeployment} canManuallyReconcile={user.role === 'ADMIN'} manuallyReconciling={manualReconcilingJobId === deploymentJob.id} onManualReconcile={manuallyReconcileDeployment} />}
        </div>

        <aside className="deploy-summary" aria-label="배포 대상">
          <p className="eyebrow">{comparisonOnly ? 'COMPARISON' : 'DEPLOYMENT TARGETS'}</p><h2>{comparisonOnly ? 'Git 타겟 · 비교 전용' : deploying ? '실제 배포 중' : deploymentJob?.status === 'SUCCEEDED' ? '배포 성공' : dryRunning ? 'Dry-run 실행 중' : dryRunJob?.status === 'APPROVAL_PENDING' ? 'Target 배포 준비' : comparing ? '메타데이터 검색 중' : deploymentCart.length > 0 ? `${deploymentCart.length}개 선택됨` : '선택된 배포 대상이 없습니다'}</h2>
          <dl><div><dt>Desired source</dt><dd>{sourceSummary(source)}</dd></div><div><dt>Target</dt><dd>{sourceSummary(target)}</dd></div><div><dt>현재 검색</dt><dd>{selectedMetadataType?.name ?? 'type 선택 필요'}</dd></div><div><dt>{comparisonOnly ? '작업 모드' : '직접 배포 테스트'}</dt><dd>{comparisonOnly ? '비교 전용' : directTestSummary(testLevel, testNames.length)}</dd></div></dl>
          <section className="deployment-cart" aria-label="선택한 배포 목록">
            <div className="deployment-cart-head"><strong>배포 대상</strong><span>{deploymentCart.length}개</span></div>
            {deploymentCart.length === 0
              ? <p>{comparisonOnly ? 'Git 타겟에는 배포 항목을 담을 수 없습니다.' : '불러온 목록에서 배포할 항목을 선택하세요.'}</p>
              : <ul>{deploymentCart.map((item) => <li key={item.key}><span><strong>{item.fullName}</strong><small>{item.type}</small></span><button type="button" disabled={dryRunning || deploying} aria-label={`${item.fullName} 배포 대상에서 제거`} onClick={() => setDeploymentCart((current) => current.filter((entry) => entry.key !== item.key))}><Icon name="trash" /></button></li>)}</ul>}
            {deploymentCart.length > 0 && <button className="cart-clear" type="button" disabled={dryRunning || deploying} onClick={() => setDeploymentCart([])}>배포 대상 비우기</button>}
          </section>
          <div className="checksum-preview"><span>PAYLOAD SHA-256</span><code>{dryRunJob?.payloadChecksum ?? deploymentJob?.payloadChecksum ?? '작업 완료 후 계산'}</code></div>
          <div className="warning-note"><Icon name="shield" /><p><strong>TARGET ONLY는 선택할 수 없습니다.</strong></p></div>
          {dryRunJob !== null && <DryRunLiveProgress liveStatus={liveStatus} job={dryRunJob} />}
          {dryRunSubmitting && dryRunJob === null && <SubmissionProgress kind="Dry-run" />}
          <div className="cart-actions">
            <button className={`button button-primary${dryRunning ? ' button-busy' : ''}`} type="button" onClick={() => void startDryRun()} disabled={!deploymentTargetValid || !canRun || dryRunning || deploying || deploymentCart.length === 0 || !testSelectionValid}><Icon name={dryRunning ? 'refresh' : 'shield'} />{dryRunSubmitting ? 'Dry-run 요청 중……' : dryRunning ? 'Dry-run 중……' : '배포 대상 Dry-run'}<Icon name="arrow" /></button>
          </div>
          <section className="deployment-approval" aria-label="Target 바로 배포">
            <strong>Target 바로 배포</strong>
            <p>{comparisonOnly ? 'Git 저장소는 비교만 가능하며 배포할 수 없습니다.' : dryRunJob?.status === 'APPROVAL_PENDING'
              ? 'Dry-run을 통과한 동일 payload를 배포합니다.'
              : directDeploymentDescription(testLevel, testNames.length)}</p>
            {!comparisonOnly && <p>선택한 Salesforce org에 실제 반영됩니다. 브라우저를 닫아도 배포는 계속됩니다.</p>}
            {!canDeploy && <p className="approval-denied">DEPLOYER 또는 ADMIN 역할만 실제 배포할 수 있습니다.</p>}
            <button className={`button button-danger${deploying ? ' button-busy' : ''}`} type="button" onClick={() => void executeDeployment()} disabled={!deploymentTargetValid || !canDeploy || deploymentCart.length === 0 || !testSelectionValid || dryRunning || deploying}><Icon name={deploying ? 'refresh' : 'deploy'} />{deploymentSubmitting ? '배포 요청 중……' : deploying ? '배포 중……' : '배포 대상 실제 배포'}</button>
          </section>
        </aside>
      </div>
    </div>
  );
}

function sourceSummary(source: WorkspaceSource | undefined): string {
  if (source === undefined) return '선택 대기';
  return (source.location === 'git'
    ? [source.label, source.provenance?.refName, source.provenance?.commitSha.slice(0, 12)]
    : [source.label, source.username, source.maskedOrgId]).filter(Boolean).join(' · ');
}

function OptionToggle({ title, description, checked, onChange, disabled = false }: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`option-toggle${disabled ? ' option-toggle-disabled' : ''}`}>
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" />
    </label>
  );
}
