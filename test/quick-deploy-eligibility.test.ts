import { describe, expect, it } from 'vitest';

import { evaluateQuickDeployEligibility } from '../src/deploy/quick-deploy-eligibility.js';
import type { DeploymentAttempt } from '../src/deploy/deployment-attempt-repository.js';
import type { DeploymentJob } from '../src/deploy/deployment-job-model.js';

const identity = { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' };
const plan = { level: 'RunLocalTests' as const, tests: [], selection: 'configured' as const };
const checksum = 'a'.repeat(64);

function job(kind: DeploymentJob['kind']): DeploymentJob {
  return {
    id: kind.toLowerCase(), kind, status: kind === 'DRY_RUN' ? 'APPROVAL_PENDING' : 'QUEUED',
    source: 'local:source', targetAlias: 'target', manifestPath: 'manifest/package.xml', scope: 'MANIFEST',
    payloadChecksum: checksum, payloadDigestVersion: 2, createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z', prepared: true, remoteStatus: 'SUCCEEDED',
    targetOrgIdentity: identity, testPlan: plan,
    ...(kind === 'DRY_RUN' ? { dryRunResult: { result: { checkOnly: true, done: true, success: true, status: 'Succeeded' } } } : {}),
  };
}

function validation(overrides: Partial<DeploymentAttempt> = {}): DeploymentAttempt {
  return {
    id: 'attempt', jobId: 'dry_run', operation: 'VALIDATE', submissionState: 'TERMINAL',
    validationId: '0Af000000000001AAA', targetOrgIdentity: identity, payloadChecksum: checksum,
    digestVersion: 2, startedAt: '2026-09-21T00:00:00.000Z', remoteStatus: 'SUCCEEDED', version: 2,
    ...overrides,
  };
}

describe('Quick Deploy 적격성', () => {
  it('동일한 v2 payload와 성공한 check-only attempt만 지정 ID의 Quick Deploy로 판정한다', () => {
    expect(evaluateQuickDeployEligibility({ dryRun: job('DRY_RUN'), deploy: job('DEPLOY'), validationAttempt: validation() }))
      .toEqual({ mode: 'QUICK_DEPLOY', reasons: [], validationId: '0Af000000000001AAA' });
  });

  it('검증 attempt가 진행 중이면 재제출 대신 재확인으로 분류한다', () => {
    expect(evaluateQuickDeployEligibility({
      dryRun: job('DRY_RUN'), deploy: job('DEPLOY'), validationAttempt: validation({ submissionState: 'SUBMITTED' }),
    })).toMatchObject({ mode: 'RECONCILE_REQUIRED' });
  });

  it('NoTestRun 또는 검증 ID 누락은 일반 배포로만 분류한다', () => {
    const dryRun = job('DRY_RUN');
    dryRun.testPlan = { ...plan, level: 'NoTestRun' };
    const deploy = job('DEPLOY');
    deploy.testPlan = dryRun.testPlan;
    expect(evaluateQuickDeployEligibility({ dryRun, deploy, validationAttempt: validation() })).toMatchObject({ mode: 'STANDARD_DEPLOY' });
    const withoutValidationId = validation();
    delete withoutValidationId.validationId;
    expect(evaluateQuickDeployEligibility({ dryRun: job('DRY_RUN'), deploy: job('DEPLOY'), validationAttempt: withoutValidationId }))
      .toMatchObject({ mode: 'STANDARD_DEPLOY' });
  });

  it('payload 또는 check-only 증거가 다르면 재검증을 요구한다', () => {
    const deploy = job('DEPLOY');
    deploy.payloadChecksum = 'b'.repeat(64);
    expect(evaluateQuickDeployEligibility({ dryRun: job('DRY_RUN'), deploy, validationAttempt: validation() }))
      .toMatchObject({ mode: 'REVALIDATION_REQUIRED' });
  });
});
