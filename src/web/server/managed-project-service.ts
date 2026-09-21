import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceProject } from '../../api/workspace-contracts.js';

export interface ManagedProject extends WorkspaceProject {
  origin?: 'git';
  realPath: string;
  ownerUserId: string;
  expiresAt: number;
  sizeBytes: number;
}

interface PendingProject {
  ownerUserId: string;
  sizeBytes: number;
  deleting?: boolean;
}

export class ManagedProjectQuotaError extends Error {}

// Source validation belongs to the import caller. This class only owns
// storage accounting, directory boundaries, ownership, lifetime and queue pins.
export class ManagedProjectService {
  private readonly directories = new Map<string, string>();
  private readonly completed = new Map<string, ManagedProject>();
  private readonly pending = new Map<string, PendingProject>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pins = new Map<string, number>();
  private readonly deletions = new Map<string, Promise<void>>();
  private closed = false;

  public constructor(
    private readonly root: string,
    private readonly userQuota: number,
    private readonly serverQuota: number,
    private readonly ttlMs = 4 * 60 * 60 * 1_000,
    private readonly label = '관리형 프로젝트',
  ) {
    if (![userQuota, serverQuota, ttlMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('관리형 프로젝트 제한값은 양의 정수여야 합니다.');
    }
  }

  public async begin(ownerUserId: string, isolation?: { sessionId: string; jobId: string; side: string }): Promise<{ id: string; directory: string }> {
    if (this.closed) throw new Error('프로젝트 저장소가 종료되었습니다.');
    const id = randomUUID();
    if (isolation !== undefined && ![isolation.sessionId, isolation.jobId, isolation.side].every((v) => /^[a-zA-Z0-9_-]{1,100}$/u.test(v))) throw this.unavailable();
    const parent = isolation === undefined ? this.root : path.join(this.root, isolation.sessionId, isolation.jobId, isolation.side);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = path.join(parent, id);
    this.directories.set(id, directory);
    this.pending.set(id, { ownerUserId, sizeBytes: 0 });
    try {
      await mkdir(directory, { mode: 0o700 });
      if (this.closed) {
        await rm(directory, { recursive: true, force: true });
        throw new Error('프로젝트 저장소가 종료되었습니다.');
      }
      return { id, directory };
    } catch (error) {
      this.pending.delete(id);
      this.directories.delete(id);
      throw error;
    }
  }

  public recordBytes(id: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('프로젝트 크기 증가량이 올바르지 않습니다.');
    const current = this.requirePending(id);
    const allocations = [...this.completed.values(), ...this.pending.values()];
    const serverTotal = allocations.reduce((total, entry) => total + entry.sizeBytes, bytes);
    const userTotal = allocations.filter((entry) => entry.ownerUserId === current.ownerUserId)
      .reduce((total, entry) => total + entry.sizeBytes, bytes);
    if (userTotal > this.userQuota) throw new ManagedProjectQuotaError('사용자별 프로젝트 저장 공간 한도를 초과했습니다.');
    if (serverTotal > this.serverQuota) throw new ManagedProjectQuotaError('서버 전체 프로젝트 저장 공간 한도를 초과했습니다.');
    current.sizeBytes += bytes;
  }

  public pendingDirectory(id: string, ownerUserId: string): string {
    const pending = this.requirePending(id);
    if (pending.ownerUserId !== ownerUserId) throw this.unavailable();
    return this.directories.get(id)!;
  }

  // Caller must remove the corresponding physical files before lowering usage.
  public releasePendingBytes(id: string, bytes: number): void {
    const pending = this.requirePending(id);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > pending.sizeBytes) throw this.unavailable();
    pending.sizeBytes -= bytes;
  }

  public async complete(id: string, ownerUserId: string,
    project: WorkspaceProject & { realPath: string; origin?: 'git' }): Promise<ManagedProject> {
    const directory = this.pendingDirectory(id, ownerUserId);
    const [allocationRoot, projectPath] = await Promise.all([realpath(directory), realpath(project.realPath)]);
    const relative = path.relative(allocationRoot, projectPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !isWithin(this.root, allocationRoot)) throw new Error('프로젝트 저장 경계를 벗어났습니다.');
    // Recheck after filesystem awaits: cancellation must not resurrect an import.
    const pending = this.requirePending(id);
    if (pending.ownerUserId !== ownerUserId) throw this.unavailable();
    const completed: ManagedProject = {
      id, realPath: projectPath, displayName: project.displayName, manifests: [...project.manifests],
      ownerUserId, expiresAt: Date.now() + this.ttlMs, sizeBytes: pending.sizeBytes,
      ...(project.origin === undefined ? {} : { origin: project.origin }),
    };
    this.pending.delete(id);
    this.completed.set(id, completed);
    this.schedule(completed);
    return completed;
  }

  public list(): ManagedProject[] {
    this.expire();
    return [...this.completed.values()];
  }

  public resolve(id: string, ownerUserId: string | undefined): ManagedProject {
    this.expire();
    const project = this.completed.get(id);
    if (project === undefined || ownerUserId === undefined || project.ownerUserId !== ownerUserId) throw this.unavailable();
    project.expiresAt = Date.now() + this.ttlMs;
    this.schedule(project);
    return project;
  }

  public pin(ids: readonly string[], ownerUserId: string): () => void {
    this.expire();
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (this.completed.get(id)?.ownerUserId !== ownerUserId) throw this.unavailable();
    }
    for (const id of unique) {
      this.clearTimer(id);
      this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of unique) {
        const count = this.pins.get(id) ?? 0;
        if (count > 1) { this.pins.set(id, count - 1); continue; }
        this.pins.delete(id);
        const project = this.completed.get(id);
        if (project !== undefined) {
          project.expiresAt = Date.now() + this.ttlMs;
          this.schedule(project);
        }
      }
    };
  }

  public async discard(id: string, ownerUserId?: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) throw this.unavailable();
    const project = this.completed.get(id) ?? this.pending.get(id);
    if (project === undefined || (ownerUserId !== undefined && project.ownerUserId !== ownerUserId)) throw this.unavailable();
    if ((this.pins.get(id) ?? 0) > 0) throw new Error(`작업에서 사용 중인 ${this.label}는 제거할 수 없습니다.`);
    const existing = this.deletions.get(id);
    if (existing !== undefined) return existing;
    this.clearTimer(id);
    this.completed.delete(id);
    // Keep storage charged until the physical deletion succeeds.
    this.pending.set(id, { ownerUserId: project.ownerUserId, sizeBytes: project.sizeBytes, deleting: true });
    const deletion = rm(this.directories.get(id)!, { recursive: true, force: true })
      .then(() => { this.pending.delete(id); this.directories.delete(id); })
      .finally(() => { this.deletions.delete(id); });
    this.deletions.set(id, deletion);
    return deletion;
  }

  public async close(): Promise<void> {
    if (this.pins.size > 0) throw new Error('사용 중인 프로젝트 저장소를 종료할 수 없습니다.');
    this.closed = true;
    for (const id of this.timers.keys()) this.clearTimer(id);
    await Promise.allSettled(this.deletions.values());
    await rm(this.root, { recursive: true, force: true });
    this.completed.clear();
    this.pending.clear();
  }

  private requirePending(id: string): PendingProject {
    const pending = this.pending.get(id);
    if (this.closed || pending === undefined || pending.deleting) throw this.unavailable();
    return pending;
  }

  private unavailable(): Error { return new Error(`사용할 수 없는 ${this.label}입니다.`); }

  private expire(): void {
    for (const project of this.completed.values()) {
      if (project.expiresAt <= Date.now() && !this.pins.has(project.id)) {
        void this.discard(project.id).catch(() => undefined);
      }
    }
  }

  private clearTimer(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  private schedule(project: ManagedProject): void {
    this.clearTimer(project.id);
    if (this.pins.has(project.id)) return;
    const timer = setTimeout(() => { void this.discard(project.id).catch(() => undefined); },
      Math.max(0, project.expiresAt - Date.now()));
    timer.unref();
    this.timers.set(project.id, timer);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
