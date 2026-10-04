import { useEffect, useState } from 'react';
import type { WorkspaceSource } from '../../../src/api/workspace-contracts';
import { ConnectionDialog } from '../components/ConnectionDialog';

interface Props {
  open: boolean; source: WorkspaceSource; target: WorkspaceSource;
  components: { type: string; fullName: string }[]; testLevel: string; tests: string[];
  mode: 'direct' | 'validated'; validation?: { status: string; checksum?: string; validatedAt?: string };
  busy?: boolean; onConfirm(): void; onCancel(): void;
}
export function DeploymentConfirmation(props: Props) {
  const fingerprint = JSON.stringify([props.source, props.target, props.components, props.testLevel, props.tests, props.mode, props.validation]);
  const [confirmedFingerprint, setConfirmedFingerprint] = useState('');
  useEffect(() => { setConfirmedFingerprint(''); }, [props.open, fingerprint]);
  if (!props.open) return null;
  const environment = props.target.environment === 'production' ? '운영 Org' : props.target.environment === 'sandbox' ? '샌드박스 Org' : '환경 확인 필요';
  const types = [...new Set(props.components.map((item) => item.type))].sort();
  return <ConnectionDialog title="실제 배포 내용 확인" busy={props.busy ?? false} onClose={props.onCancel}>
    <section className="deployment-confirmation-summary" aria-label="배포 직전 요약">
      <p><strong>{props.mode === 'direct' ? '직접 배포' : '검증 후 승인 배포'}</strong></p>
      <h3>Source</h3><p>{props.source.label}</p>
      {props.source.provenance ? <dl>
        <dt>저장소</dt><dd>{/^https:\/\//u.test(props.source.provenance.repositoryPath) ? props.source.provenance.repositoryPath : `${props.source.provenance.host}/${props.source.provenance.repositoryPath}`}</dd>
        <dt>기준</dt><dd>{props.source.provenance.refType} · {props.source.provenance.refName}</dd>
        <dt>커밋</dt><dd><code>{props.source.provenance.commitSha}</code></dd>
        <dt>프로젝트</dt><dd>{props.source.provenance.projectRoot}</dd>
      </dl> : <p>{props.source.detail ?? '선택한 프로젝트 또는 연결 Org'}</p>}
      <h3>Target</h3><p><strong>{environment}</strong> · {props.target.label}</p>
      <p>{props.target.username ?? '사용자명 확인 필요'} · {props.target.maskedOrgId ?? 'Org identity 확인 필요'}</p>
      {props.target.environment !== 'sandbox' && <p className="warning-note">{props.target.environment === 'production' ? '운영 Org의 메타데이터를 변경합니다. 대상과 반영 범위를 확인하세요.' : '환경을 확인하지 못했습니다. 대상 Org를 직접 확인하세요.'}</p>}
      <p>선택 컴포넌트 {props.components.length}개 · {types.join(', ') || '범위 확인 필요'}</p>
      <details><summary>반영할 컴포넌트 목록</summary><ul>{props.components.map((item) => <li key={`${item.type}:${item.fullName}`}>{item.type} · {item.fullName}</li>)}</ul></details>
      <p>테스트 수준: {props.testLevel} · {props.tests.length ? props.tests.join(', ') : '지정 테스트 없음'}</p>
      <p>마지막 검증: {props.validation?.status ?? '사전 검증 없음'}{props.validation?.validatedAt ? ` · ${props.validation.validatedAt}` : ''}</p>
      {props.validation?.checksum && <p>검증 payload <code>{props.validation.checksum}</code></p>}
      <label><input type="checkbox" checked={confirmedFingerprint === fingerprint} disabled={props.busy} onChange={(event) => setConfirmedFingerprint(event.target.checked ? fingerprint : '')} />위 소스·대상·반영 범위를 확인했습니다.</label>
      <div className="git-actions"><button type="button" className="button button-secondary" disabled={props.busy} onClick={props.onCancel}>취소</button>
        <button type="button" className="button button-primary" disabled={props.busy || confirmedFingerprint !== fingerprint} onClick={props.onConfirm}>확인한 내용으로 실제 배포</button></div>
    </section>
  </ConnectionDialog>;
}
