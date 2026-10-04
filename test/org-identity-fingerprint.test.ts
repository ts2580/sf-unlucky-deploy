import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { orgIdentityFingerprint, type OrgIdentitySnapshot } from '../src/deploy/org-identity.js';
import { DryRunService, type CreateDirectDeploymentInput } from '../src/deploy/dry-run-service.js';
import type { DeploymentJobRepository, DeploymentJob } from '../src/deploy/deployment-job-repository.js';
import type { DeploymentCoordinator } from '../src/deploy/deployment-coordinator.js';
import type { WorkspaceService } from '../src/web/server/workspace-service.js';

const sourceIdentity: OrgIdentitySnapshot = { alias: 'source', username: 'source@example.com', orgId: '00D000000000001' };
const targetIdentity: OrgIdentitySnapshot = { alias: 'target', username: 'target@example.com', orgId: '00D000000000002', connectionId: 'target-connection', connectionGeneration: 1, instanceUrlHash: 'host-hash' };
const input: CreateDirectDeploymentInput = { scope: 'all', sourceId: 'org:source', targetOrgId: 'org:target', testLevel: 'NoTestRun', tests: [], testClassSuffix: '_Test', waitMinutes: 60, strict: false, createdBy: 'owner', clientRequestId: 'original-request-key', targetConfirmation: 'target', confirmation: '실제 배포' };
function fixture() {
  let target = { ...targetIdentity }; let source = { ...sourceIdentity };
  let existing: { job: DeploymentJob; requestHash: string } | undefined;
  const job = { id: 'job-original', kind: 'DEPLOY', status: 'QUEUED' } as DeploymentJob;
  const jobs = {
    findIdempotentDirectDeployment: vi.fn(async () => existing), findIdempotentDryRun: vi.fn(async () => existing),
    createDirectDeployment: vi.fn(async (value: { requestHash: string }) => { existing = { job, requestHash: value.requestHash }; return { job, created: true }; }),
    createIdempotentDryRun: vi.fn(async (value: { requestHash: string }) => { existing = { job, requestHash: value.requestHash }; return { job, created: true }; }),
  };
  const release = vi.fn();
  const coordinator = { assertAccepting: vi.fn(), reserveQueueSlot: vi.fn(() => ({ release })), runDeployment: vi.fn(async () => job), runDryRun: vi.fn(async () => job) };
  const workspace = {
    resolveSourceSnapshot: vi.fn(async (id: string) => ({ source: id, snapshot: { id, kind: 'org', location: 'org', label: 'source' } })),
    resolveSource: vi.fn(async (id: string) => id), projectForSources: vi.fn(() => ({ id: 'fixture-project', realPath: '/fixture-project', displayName: 'fixture', manifests: [] })),
    getOrgIdentity: vi.fn(async (alias: string) => alias === 'source' ? source : target),
    publicSource: vi.fn((id: string) => ({ id, kind: 'local', label: 'fixture' })), publicManifest: vi.fn(() => 'all'), pinSources: vi.fn(() => release),
  };
  const sfClient = { runJson: vi.fn() };
  const service = new DryRunService(jobs as unknown as DeploymentJobRepository, coordinator as unknown as DeploymentCoordinator, workspace as unknown as WorkspaceService, sfClient, '/unused-runs');
  return { service, workspace, jobs, coordinator, sfClient, job, changeTarget: () => { target = { ...target, orgId: '00D000000000099', connectionGeneration: 2 }; }, changeSource: () => { source = { ...source, orgId: '00D000000000088' }; }, existing: (hash: string) => { existing = { job, requestHash: hash }; } };
}

describe('Org identity fingerprint', () => {
  it('필드 순서와 사용자명 대소문자에 안정적이고 Org·연결 generation 변경을 구분한다', () => {
    const fingerprint = orgIdentityFingerprint(targetIdentity);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(orgIdentityFingerprint({ ...targetIdentity, username: 'TARGET@EXAMPLE.COM' })).toBe(fingerprint);
    expect(orgIdentityFingerprint({ orgId: targetIdentity.orgId, username: targetIdentity.username, alias: targetIdentity.alias, connectionId: targetIdentity.connectionId!, connectionGeneration: 1, instanceUrlHash: 'host-hash' })).toBe(fingerprint);
    expect(orgIdentityFingerprint({ ...targetIdentity, connectionGeneration: 2 })).not.toBe(fingerprint);
    expect(orgIdentityFingerprint({ ...targetIdentity, orgId: '00D000000000099' })).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(targetIdentity.orgId);
  });
  it.each(['direct', 'dry-run'])('job 없는 원래 %s 키에서 target alias가 바뀌면 작업 생성·실행 전에 거부한다', async (mode) => {
    const f = fixture(); f.changeTarget();
    const body = { ...input, expectedTargetIdentityFingerprint: orgIdentityFingerprint(targetIdentity) };
    await expect(mode === 'direct' ? f.service.createDirect(body) : f.service.create(body)).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    expect(f.jobs.createDirectDeployment).not.toHaveBeenCalled(); expect(f.jobs.createIdempotentDryRun).not.toHaveBeenCalled();
    expect(f.coordinator.runDeployment).not.toHaveBeenCalled(); expect(f.coordinator.runDryRun).not.toHaveBeenCalled(); expect(f.sfClient.runJson).not.toHaveBeenCalled();
    expect(f.workspace.getOrgIdentity).toHaveBeenCalledWith('target', true);
  });
  it('source identity 변경과 형식 오류도 새 작업을 만들지 않는다', async () => {
    const f = fixture(); f.changeSource();
    await expect(f.service.createDirect({ ...input, expectedSourceIdentityFingerprint: orgIdentityFingerprint(sourceIdentity) })).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    await expect(f.service.createDirect({ ...input, expectedTargetIdentityFingerprint: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(f.jobs.createDirectDeployment).not.toHaveBeenCalled();
  });
  it('정상 identity를 수락하고 이미 생성된 job은 alias 변경 후에도 원래 키로 회수한다', async () => {
    const f = fixture();
    const body = { ...input, expectedTargetIdentityFingerprint: orgIdentityFingerprint(targetIdentity), expectedSourceIdentityFingerprint: orgIdentityFingerprint(sourceIdentity) };
    expect(await f.service.createDirect(body)).toEqual({ job: f.job, created: true });
    f.changeTarget(); f.workspace.getOrgIdentity.mockClear();
    expect(await f.service.createDirect(body)).toEqual({ job: f.job, created: false });
    expect(f.workspace.getOrgIdentity).not.toHaveBeenCalled(); expect(f.jobs.createDirectDeployment).toHaveBeenCalledTimes(1);
    await expect(f.service.createDirect({ ...body, expectedTargetIdentityFingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('fingerprint 없는 기존 admitted 요청의 hash와 lookup 호환성을 유지한다', async () => {
    const f = fixture();
    const legacyHash = createHash('sha256').update(JSON.stringify({ projectId: input.projectId, scope: 'all', metadataType: input.metadataType,
      manifest: input.manifest, components: input.components, sourceId: input.sourceId, targetOrgId: input.targetOrgId,
      testLevel: input.testLevel, tests: [], testClassSuffix: input.testClassSuffix, waitMinutes: input.waitMinutes, strict: input.strict,
      targetConfirmation: input.targetConfirmation, confirmation: input.confirmation })).digest('hex');
    f.existing(legacyHash); f.changeTarget();
    expect(await f.service.createDirect(input)).toEqual({ job: f.job, created: false });
    expect(f.workspace.getOrgIdentity).not.toHaveBeenCalled();
  });
});
