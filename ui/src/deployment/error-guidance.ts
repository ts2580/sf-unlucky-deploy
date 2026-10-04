import type { DeploymentJobResponse } from '../../../src/api/deployment-contracts.js';

type Diagnostics = NonNullable<NonNullable<DeploymentJobResponse['progress']>['diagnostics']>;
export interface ErrorGuidance { fact: string; suggestion: string; settings?: boolean; destination?: '/auth' | '/settings' }
export function deploymentErrorGuidance(code?: string, status?: string, diagnostics?: Diagnostics): ErrorGuidance {
  if (status === 'RECONCILE_REQUIRED' || code === 'RECONCILE_REQUIRED') return {
    fact: 'Salesforce 제출 결과를 아직 확정하지 못했습니다.',
    suggestion: '이 작업의 Salesforce 상태 다시 확인을 실행하세요. 결과를 확인할 때까지 새 배포를 제출하지 마세요.',
  };
  if (['SALESFORCE_AUTH_REQUIRED', 'GIT_REAUTH_REQUIRED', 'GIT_CONNECTION_REQUIRED'].includes(code ?? '')) return {
    fact: '선택한 연결의 인증 또는 접근 확인에 실패했습니다.', settings: true, destination: '/auth',
    suggestion: '인증 관리에서 같은 계정을 다시 연결하고 기존 소스와 대상 identity를 확인하세요.',
  };
  if (code === 'ORG_IDENTITY_CHANGED') return {
    fact: '선택한 Org 또는 연결의 identity가 변경되어 작업을 중단했습니다.', settings: true, destination: '/auth',
    suggestion: '인증 관리에서 실제 대상 Org를 다시 확인하고 소스와 대상을 재검증하세요.',
  };
  if (['INVALID_SOURCE', 'DX_PROJECT_NOT_FOUND', 'PROJECT_SELECTION_REQUIRED', 'UNSAFE_PROJECT_PATH', 'GIT_REPOSITORY_URL_REQUIRED', 'REF_CHANGED', 'IMPORT_EXPIRED'].includes(code ?? '')) return {
    fact: '선택한 저장소 또는 DX 프로젝트를 현재 상태에서 사용할 수 없습니다.', settings: true, destination: '/settings',
    suggestion: '설정에서 저장소·브랜치·프로젝트 경로를 다시 확인하세요. 다른 프로젝트로 임의 변경하지 마세요.',
  };
  if (diagnostics?.testFailures.length) return { fact: 'Salesforce가 Apex 테스트 실패를 보고했습니다.', suggestion: '아래 클래스·메서드·stack trace를 확인해 테스트 또는 관련 코드를 수정한 뒤 다시 검증하세요.' };
  if (diagnostics?.codeCoverageWarnings.length) return { fact: 'Salesforce가 코드 커버리지 진단을 보고했습니다.', suggestion: '아래 커버리지 상세와 테스트 수준을 확인하세요. 테스트를 수정한 뒤 다시 검증하세요.' };
  if (diagnostics?.componentFailures.length) return { fact: 'Salesforce가 컴포넌트 오류를 보고했습니다.', suggestion: '아래 파일·컴포넌트·줄 위치를 확인하세요. 의존성 누락 여부는 대상 Org와 원문을 대조한 뒤 판단하세요.' };
  return { fact: '이 작업을 완료하지 못했습니다.', suggestion: '아래 오류 코드와 상세 메시지를 확인한 뒤 같은 작업의 상태와 수정할 부분을 확인하세요.' };
}

const sensitiveKey = /^(?:access[_-]?token|refresh[_-]?token|token|password|secret|sid|authorization|client[_-]?secret|sfdxAuthUrl|code[_-]?verifier)$/iu;
export function sanitizedErrorDetails(value: string): string {
  return sanitizeText(value, 0);
}
function sanitizeText(value: string, depth: number): string {
  if (depth >= 16) return '[중첩된 상세 제거]';
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(sanitizeValue(parsed, depth + 1), null, 2);
  } catch { /* Non-JSON provider messages are handled as text. */ }
  return value
    .replace(/force:\/\/\S+/giu, '[인증 URL 제거]')
    .replace(/\b(Bearer|Basic)\s+\S+/giu, '$1 [비밀값 제거]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,})/gu, '[비밀값 제거]')
    .replace(/https?:\/\/[^\s<>"']+/giu, (raw) => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[URL 제거]'; }
    })
    .replace(/((?:access_token|refresh_token|token|password|secret|sid|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu,
      (_match, prefix: string, quoted: string) => `${prefix}${quoted[0]}[비밀값 제거]${quoted[0]}`)
    .replace(/\b(?:access_token|refresh_token|token|password|secret|sid|authorization)\s*[:=]\s*(?!["'])[^\s,"'}]+/giu, '[비밀값 제거]')
    .replace(/\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]+/gu, '[세션 제거]')
    .replace(/(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\/(?:home|Users|tmp|var|opt|srv|root|mnt|data|etc|usr|workspace)\/)[^\s<>"']+/gu, '[서버 경로 제거]');
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= 16) return '[중첩된 상세 제거]';
  if (typeof value === 'string') return sanitizeText(value, depth + 1);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    sensitiveKey.test(key) ? '[비밀값 제거]' : sanitizeValue(item, depth + 1)]));
  return value;
}
