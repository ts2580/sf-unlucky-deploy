import { useState } from 'react';
import type { DeploymentJobResponse } from '../../../src/api/deployment-contracts';
import { deploymentErrorGuidance, sanitizedErrorDetails } from './error-guidance';

export function ErrorGuidance({ job, errorCode, errorMessage, onSettings }: { job?: DeploymentJobResponse; errorCode?: string; errorMessage?: string; onSettings?: (path?: '/auth' | '/settings') => void }) {
  const [copied, setCopied] = useState('');
  const guidance = deploymentErrorGuidance(job?.errorCode ?? errorCode, job?.status, job?.progress?.diagnostics);
  const details = sanitizedErrorDetails(JSON.stringify({ jobId: job?.id, status: job?.status, code: job?.errorCode ?? errorCode,
    message: job?.errorMessage ?? errorMessage, diagnostics: job?.progress?.diagnostics }, null, 2));
  return <section className="warning-note" aria-label="오류 해결 안내"><div>
    <strong>{guidance.fact}</strong><p>{guidance.suggestion}</p>
    {guidance.settings && onSettings && <button className="small-button" type="button" onClick={() => onSettings(guidance.destination)}>연결·프로젝트 설정 확인</button>}
    <button className="small-button" type="button" onClick={() => {
      if (!navigator.clipboard?.writeText) { setCopied('복사 API를 사용할 수 없습니다. 아래 상세를 선택해 복사하세요.'); return; }
      void navigator.clipboard.writeText(details).then(() => setCopied('상세 오류를 복사했습니다.'), () => setCopied('복사하지 못했습니다. 아래 상세를 선택해 복사하세요.'));
    }}>정제된 상세 오류 복사</button>
    {copied && <p role="status">{copied}</p>}
    <details><summary>오류 코드와 정제된 상세</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details}</pre></details>
  </div></section>;
}
