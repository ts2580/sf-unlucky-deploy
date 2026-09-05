export interface HealthResponse {
  status: 'ok';
  service: 'sfud-ui';
  version: string;
}

export interface DiagnosticsResponse extends HealthResponse {
  host: string;
  port: number;
  storage: {
    engine: 'sqlite';
    status: 'ok';
  };
  queue: {
    activeJobId?: string;
    queuedCount: number;
  };
  comparisonQueue: {
    activeJobId?: string;
    queuedCount: number;
  };
  recoveredJobCount: number;
  recoveredComparisonCount: number;
}

export type ApiUserRole = 'VIEWER' | 'OPERATOR' | 'DEPLOYER' | 'ADMIN';

export interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  role: ApiUserRole;
}

export interface AuthStatusResponse {
  setupRequired: boolean;
  authenticated: boolean;
  user?: ApiUser;
}

export interface AuthSessionResponse {
  user: ApiUser;
  csrfToken: string;
  expiresAt: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
