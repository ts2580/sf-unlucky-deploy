import type { ComparisonResult, ComparisonSummary } from '../metadata/comparator.js';
import type { ApexTestPlan, RequestedTestLevel } from './test-plan.js';
import type { SelectedMetadataComponent } from './selected-manifest.js';
import type { SalesforceDeploymentProgress } from './salesforce-deployment.js';
import type { OrgIdentitySnapshot } from './org-identity.js';

export type DeploymentJobKind = 'DRY_RUN' | 'DEPLOY';
export type DeploymentScope = 'MANIFEST' | 'ALL';
export type RemoteDeploymentStatus =
  | 'NOT_SUBMITTED'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN';
export type DeploymentJobStatus =
  | 'QUEUED'
  | 'DRY_RUN_RUNNING'
  | 'APPROVAL_PENDING'
  | 'DEPLOYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RECONCILE_REQUIRED';

export interface DeploymentJob {
  id: string;
  kind: DeploymentJobKind;
  status: DeploymentJobStatus;
  source: string;
  targetAlias: string;
  manifestPath: string;
  scope: DeploymentScope;
  metadataType?: string;
  payloadChecksum: string;
  runDirectory?: string;
  salesforceDeploymentId?: string;
  dryRunJobId?: string;
  createdBy?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  prepared: boolean;
  comparisonArtifactPath?: string;
  dryRunArtifactPath?: string;
  deploymentArtifactPath?: string;
  comparisonSummary?: ComparisonSummary;
  testCoverage?: number;
  comparisonResult?: ComparisonResult;
  testPlan?: ApexTestPlan;
  dryRunResult?: unknown;
  selectedComponents?: SelectedMetadataComponent[];
  deploymentResult?: unknown;
  progress?: SalesforceDeploymentProgress;
  remoteStatus: RemoteDeploymentStatus;
  persistenceWarning?: string;
  sourceOrgIdentity?: OrgIdentitySnapshot;
  targetOrgIdentity?: OrgIdentitySnapshot;
  artifactsExpired?: boolean;
}

export interface CreateDryRunJobInput {
  source: string;
  targetAlias: string;
  manifestPath: string;
  scope?: DeploymentScope;
  metadataType?: string;
  payloadChecksum: string;
  runDirectory?: string;
  createdBy?: string;
  selectedComponents?: SelectedMetadataComponent[];
  sourceOrgIdentity?: OrgIdentitySnapshot;
  targetOrgIdentity: OrgIdentitySnapshot;
}

export interface CreateDirectDeploymentJobInput extends CreateDryRunJobInput {
  createdBy: string;
  clientRequestId: string;
  requestHash: string;
  requestedTestLevel: RequestedTestLevel;
  requestedTests: string[];
  targetConfirmation: string;
  confirmation: string;
}

export interface CreateIdempotentDryRunJobInput extends CreateDryRunJobInput {
  createdBy: string;
  clientRequestId: string;
  requestHash: string;
}

export interface CreateDryRunJobResult {
  job: DeploymentJob;
  created: boolean;
}

export interface CreateDirectDeploymentJobResult {
  job: DeploymentJob;
  created: boolean;
}

export interface TransitionDetails {
  completedAt?: string;
  salesforceDeploymentId?: string;
  errorCode?: string;
  errorMessage?: string;
  remoteStatus?: RemoteDeploymentStatus;
  persistenceWarning?: string;
}

export interface ApproveDeploymentInput {
  dryRunJobId: string;
  approvedBy: string;
  payloadChecksum: string;
  targetAlias: string;
  confirmation: string;
}

export interface DeploymentJobRow {
  id: string;
  kind: DeploymentJobKind;
  status: DeploymentJobStatus;
  source: string;
  target_alias: string;
  manifest_path: string;
  scope: DeploymentScope;
  metadata_type: string | null;
  payload_checksum: string;
  run_directory: string | null;
  salesforce_deployment_id: string | null;
  dry_run_job_id: string | null;
  created_by: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  is_prepared: number;
  comparison_result_json?: string | null;
  comparison_artifact_path?: string | null;
  test_plan_json?: string | null;
  dry_run_result_json?: string | null;
  dry_run_artifact_path?: string | null;
  selected_components_json?: string | null;
  deployment_result_json?: string | null;
  deployment_artifact_path?: string | null;
  progress_json?: string | null;
  remote_status: RemoteDeploymentStatus;
  persistence_warning: string | null;
  source_org_identity_json?: string | null;
  target_org_identity_json?: string | null;
  summary_added: number | null;
  summary_removed: number | null;
  summary_modified: number | null;
  summary_identical: number | null;
  summary_total: number | null;
  summary_different: number | null;
  test_coverage: number | null;
}

export function mapDeploymentJob(row: DeploymentJobRow): DeploymentJob {
  const comparisonResult = row.comparison_result_json == null
    ? undefined
    : JSON.parse(row.comparison_result_json) as ComparisonResult;
  const comparisonSummary = summaryFromRow(row) ?? comparisonResult?.summary;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    source: row.source,
    targetAlias: row.target_alias,
    manifestPath: row.manifest_path,
    scope: row.scope,
    ...(row.metadata_type === null ? {} : { metadataType: row.metadata_type }),
    payloadChecksum: row.payload_checksum,
    ...(row.run_directory === null ? {} : { runDirectory: row.run_directory }),
    ...(row.salesforce_deployment_id === null
      ? {}
      : { salesforceDeploymentId: row.salesforce_deployment_id }),
    ...(row.dry_run_job_id === null ? {} : { dryRunJobId: row.dry_run_job_id }),
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    prepared: row.is_prepared === 1,
    ...(row.comparison_artifact_path == null
      ? {}
      : { comparisonArtifactPath: row.comparison_artifact_path }),
    ...(row.dry_run_artifact_path == null
      ? {}
      : { dryRunArtifactPath: row.dry_run_artifact_path }),
    ...(row.deployment_artifact_path == null
      ? {}
      : { deploymentArtifactPath: row.deployment_artifact_path }),
    ...(comparisonSummary === undefined ? {} : { comparisonSummary }),
    ...(row.test_coverage === null ? {} : { testCoverage: row.test_coverage }),
    ...(comparisonResult === undefined ? {} : { comparisonResult }),
    ...(row.test_plan_json == null ? {} : { testPlan: JSON.parse(row.test_plan_json) as ApexTestPlan }),
    ...(row.dry_run_result_json == null ? {} : { dryRunResult: JSON.parse(row.dry_run_result_json) as unknown }),
    ...(row.selected_components_json == null
      ? {}
      : { selectedComponents: JSON.parse(row.selected_components_json) as SelectedMetadataComponent[] }),
    ...(row.deployment_result_json == null
      ? {}
      : { deploymentResult: JSON.parse(row.deployment_result_json) as unknown }),
    ...(row.progress_json == null
      ? {}
      : { progress: JSON.parse(row.progress_json) as SalesforceDeploymentProgress }),
    remoteStatus: row.remote_status,
    ...(row.persistence_warning === null ? {} : { persistenceWarning: row.persistence_warning }),
    ...(row.source_org_identity_json == null
      ? {}
      : { sourceOrgIdentity: JSON.parse(row.source_org_identity_json) as OrgIdentitySnapshot }),
    ...(row.target_org_identity_json == null
      ? {}
      : { targetOrgIdentity: JSON.parse(row.target_org_identity_json) as OrgIdentitySnapshot }),
  };
}

function summaryFromRow(row: DeploymentJobRow): ComparisonSummary | undefined {
  const values = [
    row.summary_added,
    row.summary_removed,
    row.summary_modified,
    row.summary_identical,
    row.summary_total,
    row.summary_different,
  ];
  if (values.some((value) => typeof value !== 'number')) return undefined;
  return {
    added: row.summary_added!,
    removed: row.summary_removed!,
    modified: row.summary_modified!,
    identical: row.summary_identical!,
    total: row.summary_total!,
    different: row.summary_different!,
  };
}
