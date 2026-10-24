/** Explicit module entry point. Keep implementation imports inside this module. */
export { SalesforceConnectionRepository } from './connection-repository.js';
export { isOrgIdentifier, normalizeSalesforceOrgId } from './org-identifier.js';
export { orgIdentityFingerprint, sameOrgIdentity } from './org-identity.js';
export { ProcessSfClient, type SfClient, redactSensitiveText } from './sf-client.js';
export { beginSalesforceRequestContext, enterSalesforceUserContext } from './user-context.js';
export { UserSfClient } from './user-sf-client.js';
