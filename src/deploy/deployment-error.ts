import { SfudError } from '../core/errors.js';
import { GitError } from '../git/git-errors.js';
import { isDefiniteSalesforceAuthFailure } from '../salesforce/sf-client.js';

export function deploymentFailureCode(error: unknown, fallback: string): string {
  if (isDefiniteSalesforceAuthFailure(error)) return 'SALESFORCE_AUTH_REQUIRED';
  if (error instanceof GitError) return error.code;
  if (error instanceof SfudError && ['ORG_IDENTITY_CHANGED', 'INVALID_SOURCE'].includes(error.code)) return error.code;
  return fallback;
}
