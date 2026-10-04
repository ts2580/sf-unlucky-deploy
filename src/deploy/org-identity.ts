export interface OrgIdentitySnapshot {
  alias: string;
  username: string;
  orgId: string;
  connectionId?: string;
  connectionGeneration?: number;
  instanceUrlHash?: string;
}

/** Public opaque identity binding; no auth data is included. Field order is versioned and stable. */
export function orgIdentityFingerprint(identity: OrgIdentitySnapshot): string {
  return createHash('sha256').update(JSON.stringify([
    'sfud-org-identity-v1', identity.alias, identity.username.toLowerCase(), identity.orgId,
    identity.connectionId ?? null, identity.connectionGeneration ?? null, identity.instanceUrlHash ?? null,
  ])).digest('hex');
}

export function sameOrgIdentity(
  expected: OrgIdentitySnapshot,
  actual: OrgIdentitySnapshot,
): boolean {
  return expected.alias === actual.alias
    && (expected.connectionId === undefined || expected.connectionId === actual.connectionId)
    && (expected.connectionGeneration === undefined || expected.connectionGeneration === actual.connectionGeneration)
    && expected.username.toLowerCase() === actual.username.toLowerCase()
    && expected.orgId === actual.orgId
    && (
      expected.instanceUrlHash === undefined
      || expected.instanceUrlHash === actual.instanceUrlHash
    );
}
import { createHash } from 'node:crypto';
