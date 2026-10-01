export interface OrgIdentitySnapshot {
  alias: string;
  username: string;
  orgId: string;
  connectionId?: string;
  connectionGeneration?: number;
  instanceUrlHash?: string;
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
