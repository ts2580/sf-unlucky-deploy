export interface OrgIdentitySnapshot {
  alias: string;
  username: string;
  orgId: string;
  instanceUrlHash?: string;
}

export function sameOrgIdentity(
  expected: OrgIdentitySnapshot,
  actual: OrgIdentitySnapshot,
): boolean {
  return expected.alias === actual.alias
    && expected.username.toLowerCase() === actual.username.toLowerCase()
    && expected.orgId === actual.orgId
    && (
      expected.instanceUrlHash === undefined
      || expected.instanceUrlHash === actual.instanceUrlHash
    );
}
