import { SfudError } from '../core/errors.js';
import type { WorkspaceService } from '../web/server/workspace-service.js';
import type { DeploymentJob, DeploymentJobRepository } from './deployment-job-repository.js';
import { sameOrgIdentity, type OrgIdentitySnapshot } from './org-identity.js';

export async function assertDeploymentOrgIdentities(
  job: DeploymentJob,
  jobs: DeploymentJobRepository,
  workspace: WorkspaceService,
): Promise<void> {
  const expectedIdentities: Array<{ role: 'source' | 'target'; identity: OrgIdentitySnapshot }> = [
    ...(job.sourceOrgIdentity === undefined
      ? []
      : [{ role: 'source' as const, identity: job.sourceOrgIdentity }]),
    ...(job.targetOrgIdentity === undefined
      ? []
      : [{ role: 'target' as const, identity: job.targetOrgIdentity }]),
  ];
  if (job.targetOrgIdentity === undefined) {
    throw new SfudError('ORG_IDENTITY_CHANGED', '저장된 target org identity가 없습니다. 작업을 다시 생성하세요.');
  }

  for (const expected of expectedIdentities) {
    let actual: OrgIdentitySnapshot | undefined;
    try {
      actual = await workspace.getOrgIdentity(expected.identity.alias, true);
    } catch {
      // 연결 해제도 identity 불일치와 같은 안전 정책으로 처리한다.
    }
    if (actual !== undefined && sameOrgIdentity(expected.identity, actual)) continue;
    await jobs.recordOrgIdentityMismatch(job.id, {
      role: expected.role,
      alias: expected.identity.alias,
      expected: publicIdentity(expected.identity),
      ...(actual === undefined ? { actual: 'unavailable' } : { actual: publicIdentity(actual) }),
    });
    throw new SfudError(
      'ORG_IDENTITY_CHANGED',
      `${expected.role === 'target' ? '대상' : '소스'} org identity가 작업 생성 이후 변경되어 Salesforce 제출을 중단했습니다.`,
    );
  }
}

function publicIdentity(identity: OrgIdentitySnapshot): Record<string, string> {
  return {
    username: maskUsername(identity.username),
    orgId: maskOrgId(identity.orgId),
    ...(identity.instanceUrlHash === undefined
      ? {}
      : { instanceUrlHash: identity.instanceUrlHash.slice(0, 12) }),
  };
}

function maskUsername(value: string): string {
  const at = value.indexOf('@');
  if (at < 1) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, Math.min(2, at))}…${value.slice(at)}`;
}

function maskOrgId(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 3)}…` : `${value.slice(0, 5)}…${value.slice(-3)}`;
}
