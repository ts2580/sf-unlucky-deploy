import { apiRequest } from '../api-client';
import type { ComparisonFileDifference } from '../ComparisonFileDiff';

export interface ComparisonComponent {
  key: string;
  type: string;
  fullName: string;
  status: 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL';
  files: ComparisonFileDifference[];
}

export interface ComparisonJobResponse {
  id: string;
  mode?: 'compare' | 'source';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  scope?: 'all' | 'manifest';
  metadataType?: string;
  manifest: string;
  left: { id: string; kind: 'org' | 'local'; label: string };
  right: { id: string; kind: 'org' | 'local'; label: string };
  errorMessage?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  summary?: ComparisonSummary;
  result?: {
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
