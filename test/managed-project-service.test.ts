import { access, chmod, mkdir, mkdtemp, realpath, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedProjectService } from '../src/web/server/managed-project-service.js';
import { scavengeStaleProjectRoots } from '../src/web/server/workspace-service.js';
import { WorkspaceService } from '../src/web/server/workspace-service.js';
import type { SfClient } from '../src/salesforce/sf-client.js';

const roots: string[] = [];
const services: ManagedProjectService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const service of services.splice(0)) await service.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(userQuota = 100, serverQuota = 150) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sfud-managed-test-')));
  roots.push(root);
  const service = new ManagedProjectService(root, userQuota, serverQuota, 1000);
  services.push(service);
  const complete = async (owner: string, size = 30) => {
    const allocation = await service.begin(owner);
    service.recordBytes(allocation.id, size);
    return service.complete(allocation.id, owner, {
      id: allocation.id, displayName: 'project', realPath: allocation.directory, manifests: [],
    });
  };
  return { root, service, complete };
}

describe('관리형 프로젝트 수명주기', () => {
  it('대기 작업부터 중복 pin을 유지하고 마지막 해제 뒤 TTL을 다시 시작한다', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { service, complete } = await fixture();
    const project = await complete('owner');
    const first = service.pin([project.id, project.id], 'owner');
    const second = service.pin([project.id], 'owner');
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.list()).toHaveLength(1);
    await expect(service.close()).rejects.toThrow('사용 중');
    await expect(service.discard(project.id, 'owner')).rejects.toThrow('사용 중');
    first(); first();
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.list()).toHaveLength(1);
    second();
    await vi.advanceTimersByTimeAsync(999);
    expect(service.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.list()).toHaveLength(0);
    await service.close();
    await expect(access(project.realPath)).rejects.toThrow();
  });

  it('완료 소스와 수신 중 소스를 합산하고 음수·소수 quota 우회를 막는다', async () => {
    const { service, complete } = await fixture();
    const first = await complete('a', 60);
    const pending = await service.begin('a');
    expect(() => service.recordBytes(pending.id, 41)).toThrow('사용자별');
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => service.recordBytes(pending.id, value)).toThrow();
    }
    service.recordBytes(pending.id, 40);
    const other = await service.begin('b');
    expect(() => service.recordBytes(other.id, 51)).toThrow('서버 전체');
    service.recordBytes(other.id, 50);
    await service.discard(first.id, 'a');
    service.recordBytes(other.id, 50);
    expect(() => service.recordBytes(other.id, 1)).toThrow('사용자별');
  });

  it('다른 사용자 접근과 프로젝트 경계 탈출을 거부하고 실패한 pin을 남기지 않는다', async () => {
    const { root, service, complete } = await fixture();
    const project = await complete('owner');
    expect(() => service.resolve(project.id, 'other')).toThrow();
    expect(() => service.pin([project.id], 'other')).toThrow();
    expect(() => service.pin([project.id, 'missing'], 'owner')).toThrow();
    await expect(service.discard(project.id, 'other')).rejects.toThrow();
    await service.discard(project.id, 'owner');
    const pending = await service.begin('owner');
    const sibling = path.join(root, 'outside');
    await mkdir(sibling);
    await expect(service.complete(pending.id, 'owner', {
      id: pending.id, realPath: sibling, displayName: 'outside', manifests: [],
    })).rejects.toThrow('경계');
    await service.discard(pending.id, 'owner');
    await expect(service.complete(pending.id, 'owner', {
      id: pending.id, realPath: pending.directory, displayName: 'cancelled', manifests: [],
    })).rejects.toThrow();
    expect(service.list()).toEqual([]);
  });

  it('새 sfud-imports와 레거시 sfud-uploads root를 소유권·권한·mtime 기준으로 정리한다', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-project-scavenger-'));
    try {
      const staleImport = path.join(temporaryDirectory, 'sfud-imports-999999-fixture');
      const staleLegacy = path.join(temporaryDirectory, 'sfud-uploads-999998-fixture');
      const active = path.join(temporaryDirectory, `sfud-imports-${process.pid}-fixture`);
      const unsafeMode = path.join(temporaryDirectory, 'sfud-uploads-999997-fixture');
      await Promise.all([mkdir(staleImport), mkdir(staleLegacy), mkdir(active), mkdir(unsafeMode)]);
      await Promise.all([chmod(staleImport, 0o700), chmod(staleLegacy, 0o700), chmod(active, 0o700), chmod(unsafeMode, 0o755)]);
      const old = new Date(0);
      await Promise.all([utimes(staleImport, old, old), utimes(staleLegacy, old, old), utimes(active, old, old), utimes(unsafeMode, old, old)]);

      expect(await scavengeStaleProjectRoots(temporaryDirectory, 5 * 60 * 60 * 1_000))
        .toBe(process.platform === 'win32' ? 3 : 2);
      await expect(access(staleImport)).rejects.toThrow();
      await expect(access(staleLegacy)).rejects.toThrow();
      await expect(access(active)).resolves.toBeUndefined();
      if (process.platform === 'win32') await expect(access(unsafeMode)).rejects.toThrow();
      else await expect(access(unsafeMode)).resolves.toBeUndefined();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('명시 옵션이 quota env보다 우선하고 새 env가 없으면 legacy alias를 사용한다', async () => {
    vi.stubEnv('SFUD_USER_IMPORT_QUOTA_BYTES', '40');
    vi.stubEnv('SFUD_USER_UPLOAD_QUOTA_BYTES', '10');
    const sfClient: SfClient = { runJson: async () => ({ result: {} }) };
    const workspace = await WorkspaceService.create(sfClient, process.cwd(), [], { userImportQuotaBytes: 20 });
    try {
      const allocation = await workspace.managedProjects.begin('owner');
      workspace.managedProjects.recordBytes(allocation.id, 11);
      expect(() => workspace.managedProjects.recordBytes(allocation.id, 10)).toThrow('사용자별');
    } finally {
      await workspace.close();
    }

    delete process.env.SFUD_USER_IMPORT_QUOTA_BYTES;
    const legacyWorkspace = await WorkspaceService.create(sfClient, process.cwd(), []);
    try {
      const allocation = await legacyWorkspace.managedProjects.begin('owner');
      expect(() => legacyWorkspace.managedProjects.recordBytes(allocation.id, 11)).toThrow('사용자별');
    } finally {
      await legacyWorkspace.close();
    }
  });

  it('만료된 legacy upload와 새 import 경로를 public source에서 redacted label로만 노출한다', async () => {
    const legacyPath = await mkdtemp(path.join(os.tmpdir(), 'sfud-uploads-expired-'));
    const importPath = await mkdtemp(path.join(os.tmpdir(), 'sfud-imports-expired-'));
    const sfClient: SfClient = { runJson: async () => ({ result: {} }) };
    const workspace = await WorkspaceService.create(sfClient, process.cwd(), []);
    try {
      const legacy = workspace.publicSource(`local:${legacyPath}`);
      const imported = workspace.publicSource(`local:${importPath}`);
      expect(legacy).toEqual({ id: 'upload:expired', kind: 'local', label: '만료된 업로드 프로젝트' });
      expect(imported).toEqual({ id: 'git:expired', kind: 'local', label: '만료된 Git 프로젝트' });
      expect(JSON.stringify({ legacy, imported })).not.toContain(legacyPath);
      expect(JSON.stringify({ legacy, imported })).not.toContain(importPath);
    } finally {
      await workspace.close();
      await Promise.all([rm(legacyPath, { recursive: true, force: true }), rm(importPath, { recursive: true, force: true })]);
    }
  });
});
