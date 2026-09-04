import type {
  CreateDirectDeploymentRequest,
  CreateDryRunRequest,
  DeploymentJobEnvelope,
  DeploymentJobListResponse,
  ExecuteDeploymentRequest,
} from '../../../src/api/deployment-contracts';
import {
  CreateDirectDeploymentRequestSchema,
  CreateDryRunRequestSchema,
  DeploymentJobListResponseSchema,
  DeploymentJobResponseSchema,
  ExecuteDeploymentRequestSchema,
} from '../../../src/api/deployment-contracts';
import { apiRequest } from '../api-client';

export function listDeploymentJobs(signal?: AbortSignal): Promise<DeploymentJobListResponse> {
  return apiRequest('/api/v1/deployment-jobs', {
    signal, responseSchema: DeploymentJobListResponseSchema,
  });
}

export function getDeploymentJob(id: string, signal?: AbortSignal): Promise<DeploymentJobEnvelope> {
  return apiRequest(`/api/v1/deployment-jobs/${encodeURIComponent(id)}`, {
    signal, responseSchema: DeploymentJobResponseSchema,
  });
}

export function startDryRun(
  body: CreateDryRunRequest,
  signal?: AbortSignal,
): Promise<DeploymentJobEnvelope> {
  return apiRequest('/api/v1/deployments/dry-run', {
    method: 'POST', body, signal, csrf: true,
    requestSchema: CreateDryRunRequestSchema,
    responseSchema: DeploymentJobResponseSchema,
  });
}

export function executeApprovedDeployment(
  body: ExecuteDeploymentRequest,
  signal?: AbortSignal,
): Promise<DeploymentJobEnvelope> {
  return apiRequest('/api/v1/deployments/execute', {
    method: 'POST', body, signal, csrf: true,
    requestSchema: ExecuteDeploymentRequestSchema,
    responseSchema: DeploymentJobResponseSchema,
  });
}

export function startDirectDeployment(
  body: CreateDirectDeploymentRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DeploymentJobEnvelope> {
  return apiRequest('/api/v1/deployments/direct', {
    method: 'POST', body, signal, csrf: true, idempotencyKey,
    requestSchema: CreateDirectDeploymentRequestSchema,
    responseSchema: DeploymentJobResponseSchema,
  });
}

export function reconcileDeploymentJob(id: string): Promise<DeploymentJobEnvelope> {
  return apiRequest(`/api/v1/deployment-jobs/${encodeURIComponent(id)}/reconcile`, {
    method: 'POST', csrf: true, responseSchema: DeploymentJobResponseSchema,
  });
}
