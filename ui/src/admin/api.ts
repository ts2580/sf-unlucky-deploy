import type { ApiUser, ApiUserRole } from '../../../src/web/shared/api';
import { apiRequest } from '../api-client';

export interface AdminUser extends ApiUser {
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAdminUserRequest {
  displayName: FormDataEntryValue | null;
  email: FormDataEntryValue | null;
  role: FormDataEntryValue | null;
  password: FormDataEntryValue | null;
}

export interface UpdateAdminUserRequest {
  role?: ApiUserRole;
  disabled?: boolean;
}

export interface OrgExecutionGrant {
  orgId: string;
  userId: string;
  grantedBy: string;
  createdAt: string;
}

export interface OrgExecutionPolicy {
  orgId: string;
  enabledAt: string;
  grantCount: number;
}

export function listAdminUsers(signal?: AbortSignal): Promise<{ users: AdminUser[] }> {
  return apiRequest('/api/v1/admin/users', { signal });
}

export function createAdminUser(body: CreateAdminUserRequest): Promise<{ user: AdminUser }> {
  return apiRequest('/api/v1/admin/users', { method: 'POST', body, csrf: true });
}

export function updateAdminUser(
  id: string,
  body: UpdateAdminUserRequest,
): Promise<{ user: AdminUser }> {
  return apiRequest(`/api/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', body, csrf: true,
  });
}

export function listOrgExecutionGrants(signal?: AbortSignal): Promise<{ grants: OrgExecutionGrant[]; policies: OrgExecutionPolicy[]; legacyPolicies: Array<{ targetAlias: string; grantCount: number }> }> {
  return apiRequest('/api/v1/admin/org-execution-access', { signal });
}

export function grantOrgExecutionAccess(orgId: string, userId: string): Promise<void> {
  return apiRequest(`/api/v1/admin/org-execution-access/${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`, {
    method: 'PUT', csrf: true,
  });
}

export function revokeOrgExecutionAccess(orgId: string, userId: string): Promise<void> {
  return apiRequest(`/api/v1/admin/org-execution-access/${encodeURIComponent(orgId)}/${encodeURIComponent(userId)}`, {
    method: 'DELETE', csrf: true,
  });
}
