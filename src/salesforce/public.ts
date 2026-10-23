/** Explicit module entry point. Keep implementation imports inside this module. */
export { type SalesforceConnectionReader } from './connection-reader.js';
export { isOrgIdentifier, normalizeSalesforceOrgId } from './org-identifier.js';
export { type OrgIdentitySnapshot, orgIdentityFingerprint, sameOrgIdentity } from './org-identity.js';
export { ProcessSfClient, type SfClient, SfCommandNotStartedError, isAmbiguousSalesforceFailure, isDefiniteSalesforceAuthFailure, redactSensitiveText, sanitizeSfOutput, sfProcessCommand } from './sf-client.js';
export { currentSalesforceConnectionPin, currentSalesforceUserId, pinSalesforceConnection } from './user-context.js';
