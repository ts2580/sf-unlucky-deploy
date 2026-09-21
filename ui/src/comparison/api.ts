import type { WorkspaceSource } from '../../../src/api/workspace-contracts';
import { apiRequest } from '../api-client';
import type { ComparisonFileDifference } from '../ComparisonFileDiff';

export interface ComparisonComponent {
  key: string;
  type: string;
  fullName: string;
  status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL' | 'SOURCE';
  files: ComparisonFileDifference[];
}

export interface ComparisonJobResponse {
  comparisonLimit?: { maximumFiles: number; fileCount: number; exceeded: boolean };
  id: string;
  mode?: 'compare' | 'source';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  scope?: 'all' | 'manifest';
  metadataType?: string;
  manifest: string;
  left: WorkspaceSource;
  right: WorkspaceSource;
  errorMessage?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  summary?: ComparisonSummary;
  result?: {
    comparisonLimit?: { maximumFiles: number; fileCount: number; exceeded: boolean };
    summary: ComparisonSummary;
    warnings: string[];
    components: ComparisonComponent[];
  };
}

interface ComparisonSummary {
  added: number;
  removed: number;
  modified: number;
  identical: number;
  total: number;
  different: number;
}

export interface CreateComparisonRequest {
  scope: 'all';
  metadataType: string;
  leftSourceId?: string;
  rightSourceId: string;
  sourceOnly?: boolean;
  strict: boolean;
  showIdentical: boolean;
}

export function listComparisonJobs(signal?: AbortSignal): Promise<{ jobs: ComparisonJobResponse[] }> {
  return apiRequest('/api/v1/comparisons', { signal });
}

export function getComparisonJob(
  id: string,
  signal?: AbortSignal,
): Promise<{ job: ComparisonJobResponse }> {
  return apiRequest(`/api/v1/comparisons/${encodeURIComponent(id)}`, { signal });
}

export function startComparison(
  body: CreateComparisonRequest,
  signal?: AbortSignal,
): Promise<{ job: ComparisonJobResponse }> {
  return apiRequest('/api/v1/comparisons', {
    method: 'POST', body, signal, csrf: true,
  });
}
