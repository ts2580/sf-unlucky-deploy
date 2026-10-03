import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DeploymentConfirmation } from './DeploymentConfirmation';
import type { WorkspaceSource } from '../../../src/api/workspace-contracts';

const source: WorkspaceSource = { id: 'git:fixture', kind: 'local', location: 'git', label: '업무 계정', provenance: {
  provider: 'github', host: 'github.com', repositoryId: '1', repositoryPath: 'team/billing', refType: 'branch', refName: 'main',
  commitSha: '1'.repeat(40), projectRoot: 'packages/billing', importedAt: '2026-10-04', importedContentChecksum: '2'.repeat(64), sourceOwnerUserId: 'owner', importId: 'fixture',
} };
function html(environment: WorkspaceSource['environment']) {
  return renderToStaticMarkup(createElement(DeploymentConfirmation, {
    open: true, source, target: { id: 'org:target', kind: 'org', label: '같은 별칭', username: 'target@example.com', maskedOrgId: '00D…001', environment },
    components: [{ type: 'ApexClass', fullName: 'Hello' }], testLevel: 'RunSpecifiedTests', tests: ['HelloTest'], mode: 'validated',
    validation: { status: 'APPROVAL_PENDING', checksum: '3'.repeat(64) }, onConfirm: vi.fn(), onCancel: vi.fn(),
  }));
}
describe('실제 배포 확인 내용', () => {
  it('별칭과 무관하게 전체 소스 identity·대상·테스트·검증 payload를 표시한다', () => {
    const value = html('sandbox');
    for (const text of ['github.com/team/billing', 'packages/billing', '1'.repeat(40), 'target@example.com', '00D…001', 'HelloTest', '3'.repeat(64), '샌드박스 Org']) expect(value).toContain(text);
    expect(value).toMatch(/disabled=""[^>]*>확인한 내용으로 실제 배포/);
  });
  it('포트와 긴 namespace를 가진 self-hosted 전체 URL을 호스트 중복 없이 표시한다', () => {
    const repositoryPath = `https://git.example.test:8443/group/${'nested/'.repeat(12)}billing.git`;
    const value = renderToStaticMarkup(createElement(DeploymentConfirmation, {
      open: true, source: { ...source, provenance: { ...source.provenance!, host: 'git.example.test:8443', repositoryPath } },
      target: { id: 'org:target', kind: 'org', label: 'target' }, components: [], testLevel: 'RunLocalTests', tests: [],
      mode: 'direct', onConfirm: vi.fn(), onCancel: vi.fn(),
    }));
    expect(value).toContain(repositoryPath);
    expect(value).not.toContain('git.example.test:8443/https://');
  });
  it('운영과 미확인 환경을 별도 표시한다', () => {
    expect(html('production')).toContain('운영 Org의 메타데이터를 변경합니다');
    expect(html('unknown')).toContain('환경 확인 필요');
    expect(html(undefined)).toContain('환경 확인 필요');
  });
});
