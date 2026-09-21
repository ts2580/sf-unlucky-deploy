import { GitConnectionListResponseSchema, GitProvidersResponseSchema,
  type GitConnectionListResponse, type GitProvidersResponse, type GitProviderId } from '../../../src/api/git-contracts';
import { GitCatalogResponseSchema, GitImportListResponseSchema, GitImportRequestSchema, GitImportResponseSchema,
  GitRepositoryRequestSchema, GitRepositoryResponseSchema, GitRefsRequestSchema, GitRefsResponseSchema,
  type GitCatalogPage, type GitCatalogQuery, type GitImportListResponse, type GitImportRequestBody, type GitImportResponse,
  type GitRepositoryRequest, type GitRepositoryResponse, type GitRefsRequest, type GitRefsResponse } from '../../../src/api/git-project-contracts';
import { apiRequest } from '../api-client';

export const providerNames: Record<GitProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
export const providers = () => apiRequest<GitProvidersResponse>('/api/v1/git/providers', { responseSchema: GitProvidersResponseSchema });
export const connections = (signal?: AbortSignal) => apiRequest<GitConnectionListResponse>('/api/v1/git/connections', { signal, responseSchema: GitConnectionListResponseSchema });
export const imports = () => apiRequest<GitImportListResponse>('/api/v1/git/imports', { responseSchema: GitImportListResponseSchema });
export const inspect = (body: GitRepositoryRequest, signal?: AbortSignal) => apiRequest<GitRepositoryResponse, GitRepositoryRequest>('/api/v1/git/repositories/inspect',
  { method: 'POST', csrf: true, body, signal, requestSchema: GitRepositoryRequestSchema, responseSchema: GitRepositoryResponseSchema });
export const refs = (body: GitRefsRequest, signal?: AbortSignal) => apiRequest<GitRefsResponse, GitRefsRequest>('/api/v1/git/repositories/refs',
  { method: 'POST', csrf: true, body, signal, requestSchema: GitRefsRequestSchema, responseSchema: GitRefsResponseSchema });
export const createImport = (body: GitImportRequestBody) => apiRequest<GitImportResponse, GitImportRequestBody>('/api/v1/git/imports',
  { method: 'POST', csrf: true, body, requestSchema: GitImportRequestSchema, responseSchema: GitImportResponseSchema });
export const importById = (id: string, signal?: AbortSignal) => apiRequest<GitImportResponse>(`/api/v1/git/imports/${encodeURIComponent(id)}`,
  { signal, responseSchema: GitImportResponseSchema });
export const selectImportProject = (id: string, projectRoot: string) => apiRequest<{ accepted: true }, { projectRoot: string }>(
  `/api/v1/git/imports/${encodeURIComponent(id)}/select-project`, { method: 'POST', csrf: true, body: { projectRoot } });
export function catalog(id: string, query: GitCatalogQuery, signal?: AbortSignal) {
  const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return apiRequest<GitCatalogPage>(`/api/v1/git/connections/${encodeURIComponent(id)}/repositories?${search}`,
    { signal, responseSchema: GitCatalogResponseSchema });
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Git 요청을 완료하지 못했습니다.'; }
