import type { ApiUser, AuthSessionResponse, AuthStatusResponse } from '../../../src/web/shared/api';
import { apiRequest } from '../api-client';

export interface AuthRequest {
  email: FormDataEntryValue | null;
  password: FormDataEntryValue | null;
  bootstrapToken?: FormDataEntryValue | null;
  displayName?: FormDataEntryValue | null;
}

export function getAuthStatus(signal?: AbortSignal): Promise<AuthStatusResponse> {
  return apiRequest('/api/v1/auth/status', { signal });
}

export function authenticate(
  setupRequired: boolean,
  body: AuthRequest,
): Promise<AuthSessionResponse> {
  return apiRequest(setupRequired ? '/api/v1/auth/bootstrap' : '/api/v1/auth/login', {
    method: 'POST', body,
  });
}

export async function logout(): Promise<void> {
  await apiRequest('/api/v1/auth/logout', { method: 'POST', csrf: true });
}

export type { ApiUser, AuthStatusResponse };
