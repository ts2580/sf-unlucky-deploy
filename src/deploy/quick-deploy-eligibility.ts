import type { DeploymentAttempt } from './deployment-attempt-repository.js';
import type { DeploymentJob } from './deployment-job-model.js';
import { sameOrgIdentity } from './org-identity.js';

export type DeploymentExecutionMode =
  | 'QUICK_DEPLOY'
  | 'STANDARD_DEPLOY'
  | 'REVALIDATION_REQUIRED'
  | 'RECONCILE_REQUIRED';

export interface QuickDeployEligibility {
  mode: DeploymentExecutionMode;
  reasons: string[];
  validationId?: string;
}

/**
 * Decides only from the immutable dry-run record and its tracked Salesforce
 * attempt. It deliberately does not re-read the source tree or use a
 * heuristic deployment ID.
 */
export function evaluateQuickDeployEligibility(input: {
  dryRun: DeploymentJob;
  deploy: DeploymentJob;
  validationAttempt?: DeploymentAttempt;
}): QuickDeployEligibility {
  const { dryRun, deploy, validationAttempt } = input;
  const revalidationReasons: string[] = [];
  if (dryRun.status !== 'APPROVAL_PENDING') revalidationReasons.push('성공한 dry-run 승인 대기 상태가 아닙니다.');
  if (!dryRun.prepared || dryRun.payloadDigestVersion !== 2) revalidationReasons.push('v2 고정 payload artifact가 없습니다.');
  if (deploy.payloadDigestVersion !== 2 || deploy.payloadChecksum !== dryRun.payloadChecksum) {
    revalidationReasons.push('승인 작업의 payload digest가 dry-run과 일치하지 않습니다.');
  }
  if (dryRun.targetOrgIdentity === undefined || deploy.targetOrgIdentity === undefined
    || !sameOrgIdentity(dryRun.targetOrgIdentity, deploy.targetOrgIdentity)) {
    revalidationReasons.push('승인 작업의 대상 org identity가 dry-run과 일치하지 않습니다.');
  }
  if (dryRun.testPlan === undefined || deploy.testPlan === undefined
    || !sameTestPlan(dryRun.testPlan, deploy.testPlan)) {
    revalidationReasons.push('승인 작업의 Apex 테스트 계획이 dry-run과 일치하지 않습니다.');
  }
  if (!hasConfirmedCheckOnlySuccess(dryRun)) {
    revalidationReasons.push('Salesforce check-only 성공 결과를 기록에서 확인할 수 없습니다.');
  }
  if (revalidationReasons.length > 0) return { mode: 'REVALIDATION_REQUIRED', reasons: revalidationReasons };

  if (validationAttempt === undefined || validationAttempt.operation !== 'VALIDATE') {
    return { mode: 'STANDARD_DEPLOY', reasons: ['추적된 검증 attempt가 없어 일반 배포를 사용합니다.'] };
  }
  if (validationAttempt.submissionState === 'SUBMITTING' || validationAttempt.submissionState === 'SUBMITTED') {
    return { mode: 'RECONCILE_REQUIRED', reasons: ['검증 attempt의 원격 종료 상태를 확인하지 못했습니다.'] };
  }
  if (validationAttempt.submissionState !== 'TERMINAL' || validationAttempt.remoteStatus !== 'SUCCEEDED') {
    return { mode: 'REVALIDATION_REQUIRED', reasons: ['검증 attempt가 성공 종료 상태가 아닙니다.'] };
  }
  if (validationAttempt.digestVersion !== 2 || validationAttempt.payloadChecksum !== dryRun.payloadChecksum
    || !sameOrgIdentity(validationAttempt.targetOrgIdentity, dryRun.targetOrgIdentity!)) {
    return { mode: 'REVALIDATION_REQUIRED', reasons: ['검증 attempt의 payload 또는 대상 org 증거가 dry-run과 일치하지 않습니다.'] };
  }
  if (validationAttempt.validationId === undefined) {
    return { mode: 'STANDARD_DEPLOY', reasons: ['검증 Salesforce ID가 없어 일반 배포를 사용합니다.'] };
  }
  if (dryRun.testPlan!.level === 'NoTestRun') {
    return { mode: 'STANDARD_DEPLOY', reasons: ['NoTestRun 검증은 Quick Deploy 재사용 대상이 아닙니다.'] };
  }
  return { mode: 'QUICK_DEPLOY', reasons: [], validationId: validationAttempt.validationId };
}

function sameTestPlan(
  left: NonNullable<DeploymentJob['testPlan']>,
  right: NonNullable<DeploymentJob['testPlan']>,
): boolean {
  return left.level === right.level
    && left.selection === right.selection
    && left.tests.length === right.tests.length
    && left.tests.every((test, index) => test === right.tests[index]);
}

function hasConfirmedCheckOnlySuccess(job: DeploymentJob): boolean {
  const result = deploymentResult(job.dryRunResult);
  return result?.checkOnly === true
    && result.success !== false
    && (result.done === true || (typeof result.status === 'string'
      && ['Succeeded', 'SucceededPartial'].includes(result.status)));
}

function deploymentResult(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.result) ? value.result : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
