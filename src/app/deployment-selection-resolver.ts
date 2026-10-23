import { maskOrgId } from '../sources/composition.js';
import type { DeploymentPresetSummary, DeploymentSelection, ResolvedDeploymentPreset } from '../contracts/deployment-preset-contracts.js';
import type { SavedDeploymentSelection, SavedSource } from '../deploy/composition.js';
import type { WebRuntime } from './runtime.js';
import { sameOrgIdentity, orgIdentityFingerprint } from '../salesforce/composition.js';
import type { WorkspaceSource } from '../contracts/workspace-contracts.js';
import { normalizeSelectedComponents } from '../metadata/composition.js';

export async function captureSelection(runtime: WebRuntime, owner: string, selection: DeploymentSelection, refreshIdentity = true): Promise<SavedDeploymentSelection> {
  const { sourceId, targetId, expectedSourceIdentityFingerprint, expectedTargetIdentityFingerprint, ...options } = selection;
  const source = await captureSource(runtime, owner, sourceId, refreshIdentity);
  const target = await captureSource(runtime, owner, targetId, refreshIdentity);
  if (options.components !== undefined) {
    options.components = options.components.length === 0 ? [] : normalizeSelectedComponents(options.components);
    if (options.components.length > 0 && target.kind !== 'org') throw new Error('배포 항목은 Org 타겟에만 저장할 수 있습니다.');
  }
  if (source.kind === 'org' && expectedSourceIdentityFingerprint !== undefined && orgIdentityFingerprint(source.identity) !== expectedSourceIdentityFingerprint) throw new Error('원래 Source Org identity가 변경되었습니다.');
  if (target.kind === 'org' && expectedTargetIdentityFingerprint !== undefined && orgIdentityFingerprint(target.identity) !== expectedTargetIdentityFingerprint) throw new Error('원래 Target Org identity가 변경되었습니다.');
  for (const saved of [source, target]) {
    if (saved.kind === 'git' && saved.request.metadataType !== undefined && saved.request.metadataType !== options.metadataType) {
      throw new Error('준비된 Git 메타데이터 타입과 현재 비교 범위가 다릅니다.');
    }
  }
  if (source.kind === 'git' && source.request.metadataType !== undefined
    && options.components?.some((component) => component.type !== source.request.metadataType)) {
    throw new Error('준비된 Git 소스에 포함되지 않은 메타데이터 타입입니다.');
  }
  return { options, source, target };
}
async function captureSource(runtime: WebRuntime, owner: string, id: string, refreshIdentity: boolean): Promise<SavedSource> {
  const savedSource = /^git-preset:([^:]+):(source|target)$/u.exec(id);
  if (savedSource !== null) {
    const { settings } = await runtime.presets.get(owner, savedSource[1]!);
    return savedSource[2] === 'source' ? settings.source : settings.target;
  }
  if (id.startsWith('org:')) return { kind: 'org', identity: await runtime.workspace.getOrgIdentity(id.slice(4), refreshIdentity) };
  if (id.startsWith('project:')) {
    await runtime.workspace.resolveSource(id, owner);
    return { kind: 'project', id };
  }
  if (id.startsWith('git-registered:')) {
    const registration = await runtime.gitRegistrations.get(id.slice(15), owner);
    const repository = await runtime.gitImports.inspect(registration.request, undefined, owner);
    if (repository.repositoryId !== registration.repositoryId) throw new Error('등록된 Git 저장소 identity가 변경되었습니다.');
    return { kind: 'git', registrationId: registration.id, request: registration.request, repositoryId: registration.repositoryId };
  }
  if (id.startsWith('git:')) {
    const record = await runtime.gitImports.get(id.slice(4), owner);
    if (record.status !== 'READY' || record.provenance === undefined) throw new Error('현재 준비된 Git 소스가 필요합니다.');
    const request = { provider: record.provider, repositoryPath: record.repositoryPath, ref: record.ref,
      expectedCommitSha: record.provenance.commitSha, projectRoot: record.provenance.projectRoot,
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      ...(record.metadataType === undefined ? {} : { metadataType: record.metadataType }) };
    return { kind: 'git', request, repositoryId: record.provenance.repositoryId };
  }
  throw new Error('저장할 수 없는 소스입니다. 허용된 프로젝트나 연결을 선택하세요.');
}
export async function resolvePreset(runtime: WebRuntime, owner: string, id: string, prepare = false): Promise<ResolvedDeploymentPreset> {
  const { preset, settings } = await runtime.presets.get(owner, id);
  if (prepare) return await resolveSavedSelection(runtime, owner, preset, settings, true, true);
  // Loading is an owned database read. Remote source preparation belongs to compare/deploy actions.
  const savedSource = (saved: SavedSource, side: 'source' | 'target'): WorkspaceSource => {
    if (saved.kind === 'org') return { id: `org:${saved.identity.alias}`, kind: 'org', location: 'org', label: saved.identity.alias,
      username: saved.identity.username, maskedOrgId: maskOrgId(saved.identity.orgId), orgIdentityFingerprint: orgIdentityFingerprint(saved.identity), environment: 'unknown' };
    if (saved.kind === 'project') return { id: saved.id, kind: 'local', location: 'server', label: saved.id };
    return { id: saved.registrationId === undefined ? `git-preset:${id}:${side}` : `git-registered:${saved.registrationId}`,
      kind: 'local', location: 'git', label: `${saved.request.repositoryPath} · ${saved.request.ref.name}` };
  };
  const source = savedSource(settings.source, 'source'); const target = savedSource(settings.target, 'target');
  return { preset, source, target, selection: { ...settings.options, sourceId: source.id, targetId: target.id,
    ...(source.orgIdentityFingerprint === undefined ? {} : { expectedSourceIdentityFingerprint: source.orgIdentityFingerprint }),
    ...(target.orgIdentityFingerprint === undefined ? {} : { expectedTargetIdentityFingerprint: target.orgIdentityFingerprint }) },
  warnings: [], preparationRequired: settings.source.kind === 'git' || settings.target.kind === 'git' };
}
export async function resolveSavedSelection(runtime: WebRuntime, owner: string, preset: DeploymentPresetSummary, settings: SavedDeploymentSelection, prepare = false, materializeRegistered = false): Promise<ResolvedDeploymentPreset> {
  const warnings: string[] = [];
  const source = await resolveSavedSource(runtime, owner, settings.source, warnings, prepare, settings.options.metadataType, materializeRegistered);
  const target = await resolveSavedSource(runtime, owner, settings.target, warnings, prepare, settings.options.metadataType, materializeRegistered);
  return { preset,
    ...(source.id === undefined || target.id === undefined ? {} : { selection: { ...settings.options, sourceId: source.id, targetId: target.id, ...(source.source?.orgIdentityFingerprint === undefined ? {} : { expectedSourceIdentityFingerprint: source.source.orgIdentityFingerprint }), ...(target.source?.orgIdentityFingerprint === undefined ? {} : { expectedTargetIdentityFingerprint: target.source.orgIdentityFingerprint }) } }),
    ...(source.source === undefined ? {} : { source: source.source }),
    ...(target.source === undefined ? {} : { target: target.source }),
    warnings, preparationRequired: source.preparationRequired || target.preparationRequired };
}
async function resolveSavedSource(runtime: WebRuntime, owner: string, saved: SavedSource, warnings: string[], prepare: boolean, metadataType?: string, materializeRegistered = false): Promise<{ id?: string; source?: WorkspaceSource; preparationRequired: boolean }> {
  if (saved.kind === 'org') {
    const current = await runtime.workspace.getOrgIdentity(saved.identity.alias, true);
    if (!sameOrgIdentity(saved.identity, current)) throw new Error('저장한 Org identity 또는 연결이 변경되었습니다. 대상을 다시 선택하세요.');
    const id = `org:${current.alias}`;
    return { id, source: { ...runtime.workspace.publicSource(id), username: current.username, maskedOrgId: maskOrgId(current.orgId), orgIdentityFingerprint: orgIdentityFingerprint(current), environment: 'unknown' }, preparationRequired: false };
  }
  if (saved.kind === 'project') {
    await runtime.workspace.resolveSource(saved.id, owner);
    return { id: saved.id, preparationRequired: false };
  }
  const registered = saved.registrationId === undefined ? undefined : await runtime.gitRegistrations.get(saved.registrationId, owner);
  const request = registered?.request ?? saved.request;
  if (registered !== undefined && (registered.repositoryId !== saved.repositoryId
    || request.projectRoot !== saved.request.projectRoot || request.repositoryPath !== saved.request.repositoryPath
    || request.connectionId !== saved.request.connectionId || request.ref.name !== saved.request.ref.name)) {
    throw new Error('저장한 Git 등록 대상이 변경되었습니다. 소스를 다시 선택하세요.');
  }
  const repository = await runtime.gitImports.inspect(request, undefined, owner);
  if (repository.repositoryId !== saved.repositoryId) throw new Error('저장한 Git 저장소 identity가 변경되었습니다.');
  let sha: string | undefined = request.ref.kind === 'commit' ? request.ref.name : undefined;
  if (request.ref.kind !== 'commit') {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await runtime.gitImports.refs(request, request.ref.kind, cursor, owner);
      sha = page.refs.find((item) => item.name === request.ref.name)?.commitSha;
      cursor = page.nextCursor;
      if (cursor !== undefined && seen.has(cursor)) throw new Error('Git ref 조회가 반복되었습니다.');
      if (cursor !== undefined) seen.add(cursor);
    } while (sha === undefined && cursor !== undefined && seen.size < 100);
  }
  if (sha === undefined) throw new Error('저장한 Git ref 조회를 완료하지 못했습니다. ref 존재 여부와 조회 한도를 확인하세요.');
  if (sha !== saved.request.expectedCommitSha) warnings.push('Git ref가 이동했습니다. 현재 커밋으로 다시 비교·검증하세요.');
  const currentRequest = { ...request, expectedCommitSha: sha, ...(metadataType === undefined ? {} : { metadataType }) };
  const roots = await runtime.gitImports.projectRoots(owner, currentRequest);
  if (currentRequest.projectRoot === undefined || !roots.projectRoots.includes(currentRequest.projectRoot)) throw new Error('저장한 DX 프로젝트 경로를 찾을 수 없습니다.');
  if (registered !== undefined && !materializeRegistered) return { id: `git-registered:${registered.id}`, preparationRequired: false };
  if (!prepare) return { preparationRequired: true };
  const imported = await runtime.gitImports.prepareLatest(owner, currentRequest);
  if (imported.status !== 'READY' || imported.provenance === undefined) throw new Error('Git 소스 준비가 완료되지 않았습니다.');
  const source = runtime.gitImports.sourceForPath((await runtime.gitImports.resolve(imported.id, owner)).realPath);
  if (source === undefined) throw new Error('Git 소스 준비 결과를 찾을 수 없습니다.');
  return { id: source.id, source, preparationRequired: false };
}

/** Copy configuration only: never copy the original job approval, components or payload. */
export async function resolveJobSelection(runtime: WebRuntime, owner: string, jobId: string, prepare = false): Promise<ResolvedDeploymentPreset> {
  if (!await runtime.jobAccess.canAccess('deployment', jobId, owner)) throw new Error('작업을 찾을 수 없습니다.');
  const job = await runtime.deploymentJobs.getSummary(jobId);
  if (job === undefined || job.targetOrgIdentity === undefined) throw new Error('원래 작업 identity를 확인할 수 없습니다.');
  const sourceSnapshot = job.sourceSnapshot?.source ?? runtime.workspace.publicSource(job.source);
  let source: SavedSource;
  if (sourceSnapshot.location === 'git' && sourceSnapshot.provenance !== undefined) {
    const record = await runtime.gitImports.get(sourceSnapshot.provenance.importId, owner);
    if (record.status === 'DELETED' || record.provenance === undefined) throw new Error('원래 Git 연결 기록이 삭제되었습니다.');
    const provenance = sourceSnapshot.provenance;
    source = { kind: 'git', repositoryId: provenance.repositoryId, request: {
      provider: provenance.provider, repositoryPath: record.repositoryPath, ref: { kind: provenance.refType, name: provenance.refName },
      expectedCommitSha: provenance.commitSha, projectRoot: provenance.projectRoot,
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      ...(provenance.metadataType === undefined ? {} : { metadataType: provenance.metadataType }),
    } };
  } else if (job.sourceOrgIdentity !== undefined) source = { kind: 'org', identity: job.sourceOrgIdentity };
  else source = await captureSource(runtime, owner, sourceSnapshot.id, true);
  const level = job.testPlan?.level ?? 'auto';
  const allowedLevels = ['auto', 'NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'];
  if (!allowedLevels.includes(level)) throw new Error('원래 테스트 설정을 확인할 수 없습니다.');
  const metadataType = job.metadataType ?? sourceSnapshot.provenance?.metadataType;
  const settings: SavedDeploymentSelection = { source, target: { kind: 'org', identity: job.targetOrgIdentity }, options: {
    compareCurrentType: true, showIdentical: false, excludedPackageIds: [], testLevel: level, tests: job.testPlan?.tests ?? [],
    ...(metadataType === undefined ? {} : { metadataType }),
  } };
  return await resolveSavedSelection(runtime, owner, { id: job.id, name: '원래 작업 설정', schemaVersion: 1, createdAt: job.createdAt, updatedAt: job.updatedAt }, settings, prepare);
}
