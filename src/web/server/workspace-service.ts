import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listFiles } from '../../core/files.js';
import { readProjectApiVersion, withRequestWorkspace } from '../../core/request-workspace.js';
import type { SfClient } from '../../salesforce/sf-client.js';
import type { OrgIdentitySnapshot } from '../../deploy/org-identity.js';
import { discoverLocalMetadataTypes, resolveLocalPackageDirectories } from '../../metadata/local-metadata.js';

const UPLOAD_TTL_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_USER_UPLOAD_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_SERVER_UPLOAD_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface WorkspaceServiceOptions {
  userUploadQuotaBytes?: number;
  serverUploadQuotaBytes?: number;
}

export interface WorkspaceOrg {
  id: string;
  alias: string;
  label: string;
  edition?: string;
  connected: boolean;
  username?: string;
  orgId?: string;
  instanceUrlHash?: string;
}

export interface WorkspaceProject {
  id: string;
  displayName: string;
  manifests: string[];
}

export interface UploadedProject extends AllowedProject {
  ownerUserId: string;
  expiresAt: number;
  sizeBytes: number;
}

export interface WorkspaceMetadataType {
  name: string;
  directoryName: string;
}

export interface AllowedProject extends WorkspaceProject {
  realPath: string;
}

interface RawOrg {
  alias?: unknown;
  username?: unknown;
  name?: unknown;
  orgEdition?: unknown;
  connectedStatus?: unknown;
  orgId?: unknown;
  instanceUrl?: unknown;
}

export class WorkspaceService {
  private orgCache: { expiresAt: number; value: WorkspaceOrg[] } | undefined;
  private orgRequest: Promise<WorkspaceOrg[]> | undefined;
  private readonly metadataTypeCache = new Map<string, { expiresAt: number; value: WorkspaceMetadataType[] }>();
  private readonly metadataTypeRequests = new Map<string, Promise<WorkspaceMetadataType[]>>();
  private readonly apexTestClassCache = new Map<string, { expiresAt: number; value: string[] }>();
  private readonly apexTestClassRequests = new Map<string, Promise<string[]>>();
  private readonly uploadedProjects = new Map<string, UploadedProject>();
  private readonly uploadExpirationTimers = new Map<string, NodeJS.Timeout>();
  private readonly uploadPins = new Map<string, number>();
  private readonly pendingUploads = new Map<string, { ownerUserId: string; sizeBytes: number }>();

  private constructor(
    private readonly sfClient: SfClient,
    private readonly projects: AllowedProject[],
    private readonly commandProject: AllowedProject,
    private readonly uploadRoot: string,
    private readonly userUploadQuotaBytes: number,
    private readonly serverUploadQuotaBytes: number,
  ) {}

  public static async create(
    sfClient: SfClient,
    cwd: string,
    configuredPaths: string[],
    options: WorkspaceServiceOptions = {},
  ): Promise<WorkspaceService> {
    const commandProjectPath = await realpath(cwd);
    const projects: AllowedProject[] = [];
    for (const candidate of configuredPaths) {
      const projectPath = await realpath(path.resolve(cwd, candidate));
      await access(path.join(projectPath, 'sfdx-project.json'));
      if (projects.some((project) => project.realPath === projectPath)) continue;
      projects.push({
        id: createHash('sha256').update(projectPath).digest('hex').slice(0, 16),
        displayName: path.basename(projectPath),
        realPath: projectPath,
        manifests: await findManifests(projectPath),
      });
    }
    await scavengeStaleUploadRoots();
    const uploadRoot = await mkdtemp(path.join(os.tmpdir(), `sfud-uploads-${process.pid}-`));
    await chmod(uploadRoot, 0o700);
    return new WorkspaceService(sfClient, projects, {
      id: 'command-workspace',
      displayName: 'sfud command workspace',
      realPath: commandProjectPath,
      manifests: [],
    }, uploadRoot,
    configuredQuota(
      options.userUploadQuotaBytes,
      process.env.SFUD_USER_UPLOAD_QUOTA_BYTES,
      DEFAULT_USER_UPLOAD_QUOTA_BYTES,
    ),
    configuredQuota(
      options.serverUploadQuotaBytes,
      process.env.SFUD_SERVER_UPLOAD_QUOTA_BYTES,
      DEFAULT_SERVER_UPLOAD_QUOTA_BYTES,
    ));
  }

  public listProjects(): WorkspaceProject[] {
    return this.projects.map(({ id, displayName, manifests }) => ({ id, displayName, manifests }));
  }

  public listUploadedProjects(ownerUserId: string): WorkspaceProject[] {
    this.removeExpiredUploads();
    return [...this.uploadedProjects.values()]
      .filter((project) => project.ownerUserId === ownerUserId)
      .map(({ id, displayName, manifests }) => ({ id, displayName, manifests }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  public async beginProjectUpload(ownerUserId: string): Promise<{ id: string; directory: string }> {
    const id = randomUUID();
    const directory = path.join(this.uploadRoot, id);
    await mkdir(directory, { mode: 0o700 });
    this.pendingUploads.set(id, { ownerUserId, sizeBytes: 0 });
    return { id, directory };
  }

  public recordProjectUploadBytes(id: string, bytes: number): void {
    const upload = this.pendingUploads.get(id);
    if (upload === undefined) throw new Error('진행 중인 업로드를 찾을 수 없습니다.');
    const nextSize = upload.sizeBytes + bytes;
    const completed = [...this.uploadedProjects.values()];
    const pending = [...this.pendingUploads.entries()];
    const userTotal = completed
      .filter((project) => project.ownerUserId === upload.ownerUserId)
      .reduce((total, project) => total + project.sizeBytes, 0)
      + pending
        .filter(([pendingId, entry]) => pendingId !== id && entry.ownerUserId === upload.ownerUserId)
        .reduce((total, [, entry]) => total + entry.sizeBytes, 0)
      + nextSize;
    const serverTotal = completed.reduce((total, project) => total + project.sizeBytes, 0)
      + pending
        .filter(([pendingId]) => pendingId !== id)
        .reduce((total, [, entry]) => total + entry.sizeBytes, 0)
      + nextSize;
    if (userTotal > this.userUploadQuotaBytes) {
      throw new UploadQuotaError('사용자별 업로드 저장 공간 한도를 초과했습니다.');
    }
    if (serverTotal > this.serverUploadQuotaBytes) {
      throw new UploadQuotaError('서버 전체 업로드 저장 공간 한도를 초과했습니다.');
    }
    upload.sizeBytes = nextSize;
  }

  public async completeProjectUpload(
    id: string,
    ownerUserId: string,
    requestedLabel?: string,
  ): Promise<UploadedProject> {
    assertUploadId(id);
    const pending = this.pendingUploads.get(id);
    if (pending === undefined || pending.ownerUserId !== ownerUserId) {
      throw new Error('진행 중인 업로드를 찾을 수 없습니다.');
    }
    const directory = path.join(this.uploadRoot, id);
    const configurationPaths = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name === 'sfdx-project.json')
      .map((entry) => path.join(entry.parentPath, entry.name));
    if (configurationPaths.length !== 1) {
      throw new Error('업로드에는 하나의 sfdx-project.json이 필요합니다.');
    }
    const projectPath = await realpath(path.dirname(configurationPaths[0]!));
    if (!isInside(this.uploadRoot, projectPath)) throw new Error('업로드 프로젝트 경로가 올바르지 않습니다.');
    await validatePackageDirectories(projectPath, configurationPaths[0]!);
    const label = normalizeUploadLabel(requestedLabel) ?? path.basename(projectPath);
    const project: UploadedProject = {
      id,
      displayName: label,
      realPath: projectPath,
      manifests: await findManifests(projectPath),
      ownerUserId,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
      sizeBytes: pending.sizeBytes,
    };
    this.pendingUploads.delete(id);
    this.uploadedProjects.set(id, project);
    this.scheduleUploadExpiration(project);
    return project;
  }

  public async discardProjectUpload(id: string, ownerUserId?: string): Promise<void> {
    assertUploadId(id);
    const project = this.uploadedProjects.get(id);
    if (ownerUserId !== undefined && (project === undefined || project.ownerUserId !== ownerUserId)) {
      throw new Error('사용할 수 없는 업로드 프로젝트입니다.');
    }
    if ((this.uploadPins.get(id) ?? 0) > 0) {
      throw new Error('작업에서 사용 중인 업로드 프로젝트는 제거할 수 없습니다.');
    }
    const timer = this.uploadExpirationTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.uploadExpirationTimers.delete(id);
    this.pendingUploads.delete(id);
    this.uploadedProjects.delete(id);
    await rm(path.join(this.uploadRoot, id), { recursive: true, force: true });
  }

  public async close(): Promise<void> {
    for (const timer of this.uploadExpirationTimers.values()) clearTimeout(timer);
    this.uploadExpirationTimers.clear();
    this.uploadPins.clear();
    this.pendingUploads.clear();
    this.uploadedProjects.clear();
    await rm(this.uploadRoot, { recursive: true, force: true });
  }

  public async listOrgs(): Promise<WorkspaceOrg[]> {
    if (this.orgCache !== undefined && this.orgCache.expiresAt > Date.now()) return this.orgCache.value;
    if (this.orgRequest !== undefined) return this.orgRequest;
    this.orgRequest = this.loadOrgs();
    try {
      const value = await this.orgRequest;
      this.orgCache = { expiresAt: Date.now() + 5_000, value };
      return value;
    } finally {
      this.orgRequest = undefined;
    }
  }

  public async getOrgIdentity(alias: string, refresh = false): Promise<OrgIdentitySnapshot> {
    const orgs = refresh ? await this.refreshOrgs() : await this.listOrgs();
    const org = orgs.find((candidate) => candidate.alias === alias && candidate.connected);
    if (org === undefined) throw new Error(`연결된 Salesforce org가 아닙니다: ${alias}`);
    if (org.username === undefined || org.orgId === undefined) {
      throw new Error(`Salesforce org identity를 확인할 수 없습니다: ${alias}`);
    }
    return {
      alias: org.alias,
      username: org.username,
      orgId: org.orgId,
      ...(org.instanceUrlHash === undefined ? {} : { instanceUrlHash: org.instanceUrlHash }),
    };
  }

  public async listMetadataTypes(
    sourceIds: readonly string[],
    ownerUserId?: string,
  ): Promise<WorkspaceMetadataType[]> {
    const resolvedSources = await Promise.all(sourceIds.map((sourceId) =>
      this.resolveSource(sourceId, ownerUserId)));
    const aliases = [...new Set(resolvedSources.flatMap((source) =>
      source.startsWith('org:') ? [source.slice('org:'.length)] : []))];
    const localProjectPaths = [...new Set(resolvedSources.flatMap((source) =>
      source.startsWith('local:') ? [source.slice('local:'.length)] : []))];
    const project = this.projectForSources(resolvedSources);
    const values = await Promise.all([
      ...aliases.map((alias) => this.listMetadataTypesForOrg(alias, project)),
      ...localProjectPaths.map(async (projectPath) =>
        (await discoverLocalMetadataTypes(projectPath)).map((descriptor) => ({
          name: descriptor.xmlName,
          directoryName: descriptor.directoryName,
        }))),
    ]);
    const unique = new Map<string, WorkspaceMetadataType>();
    for (const value of values.flat()) unique.set(value.name, value);
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public async listApexTestClasses(sourceId: string, ownerUserId?: string): Promise<string[]> {
    const source = await this.resolveSource(sourceId, ownerUserId);
    const cached = this.apexTestClassCache.get(source);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.apexTestClassRequests.get(source);
    if (pending !== undefined) return pending;
    const request = source.startsWith('org:')
      ? this.listOrgApexTestClasses(source.slice('org:'.length), this.projectForSources([source]))
      : listLocalApexTestClasses(source.slice('local:'.length));
    this.apexTestClassRequests.set(source, request);
    try {
      const value = await request;
      this.apexTestClassCache.set(source, { expiresAt: Date.now() + 60_000, value });
      return value;
    } finally {
      this.apexTestClassRequests.delete(source);
    }
  }

  private async listOrgApexTestClasses(alias: string, project: AllowedProject): Promise<string[]> {
    const apiVersion = await readProjectApiVersion(project.realPath);
    const raw = await this.sfClient.runJson([
      'data', 'query',
      '--query', "SELECT Name FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name",
      '--use-tooling-api',
      '--target-org', alias,
      '--api-version', apiVersion,
    ], { cwd: project.realPath, timeoutMs: 60_000 });
    const records = isRecord(raw) && isRecord(raw.result) && Array.isArray(raw.result.records)
      ? raw.result.records
      : [];
    return normalizeApexClassCandidates(records.flatMap((entry) =>
      isRecord(entry) && typeof entry.Name === 'string' ? [entry.Name] : []));
  }

  private async listMetadataTypesForOrg(
    alias: string,
    project: AllowedProject,
  ): Promise<WorkspaceMetadataType[]> {
    const apiVersion = await readProjectApiVersion(project.realPath);
    const cacheKey = `${alias}:${apiVersion}`;
    const cached = this.metadataTypeCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.metadataTypeRequests.get(cacheKey);
    if (pending !== undefined) return pending;
    const projectPath = project.realPath;
    const request = withRequestWorkspace(projectPath, async (workspacePath) => {
      const raw = await this.sfClient.runJson([
        'org', 'list', 'metadata-types', '--target-org', alias, '--api-version', apiVersion,
      ], { cwd: workspacePath, timeoutMs: 60_000 });
      const metadataObjects = isRecord(raw) && isRecord(raw.result) && Array.isArray(raw.result.metadataObjects)
        ? raw.result.metadataObjects
        : [];
      return metadataObjects.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.xmlName !== 'string' || typeof entry.directoryName !== 'string') {
          return [];
        }
        return [{ name: entry.xmlName, directoryName: entry.directoryName }];
      });
    });
    this.metadataTypeRequests.set(cacheKey, request);
    try {
      const value = await request;
      this.metadataTypeCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
      return value;
    } finally {
      this.metadataTypeRequests.delete(cacheKey);
    }
  }

  private async loadOrgs(): Promise<WorkspaceOrg[]> {
    const raw = await this.sfClient.runJson(['org', 'list'], {
      cwd: this.defaultProject().realPath,
      timeoutMs: 30_000,
    });
    const result = isRecord(raw) && isRecord(raw.result) ? raw.result : {};
    const orgs = Object.values(result).flatMap((entry) => Array.isArray(entry) ? entry : []);
    const unique = new Map<string, WorkspaceOrg>();
    for (const entry of orgs) {
      if (!isRecord(entry)) continue;
      const rawOrg = entry as RawOrg;
      const alias = stringValue(rawOrg.alias) ?? stringValue(rawOrg.username);
      if (alias === undefined || !/^[A-Za-z0-9._@+-]+$/u.test(alias)) continue;
      if (!unique.has(alias)) {
        unique.set(alias, {
          id: `org:${alias}`,
          alias,
          label: stringValue(rawOrg.name) ?? alias,
          ...(stringValue(rawOrg.orgEdition) === undefined ? {} : { edition: stringValue(rawOrg.orgEdition)! }),
          connected: stringValue(rawOrg.connectedStatus)?.toLowerCase() === 'connected',
          ...(stringValue(rawOrg.username) === undefined ? {} : { username: stringValue(rawOrg.username)! }),
          ...(stringValue(rawOrg.orgId) === undefined ? {} : { orgId: stringValue(rawOrg.orgId)! }),
          ...(stringValue(rawOrg.instanceUrl) === undefined ? {} : {
            instanceUrlHash: createHash('sha256').update(normalizeInstanceUrl(stringValue(rawOrg.instanceUrl)!)).digest('hex'),
          }),
        });
      }
    }
    return [...unique.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  }

  private async refreshOrgs(): Promise<WorkspaceOrg[]> {
    const value = await this.loadOrgs();
    this.orgCache = { expiresAt: Date.now() + 5_000, value };
    return value;
  }

  public async resolveProject(projectId: string): Promise<AllowedProject> {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error('허용되지 않은 Salesforce DX 프로젝트입니다.');
    return project;
  }

  public defaultProject(): AllowedProject {
    return this.projects[0] ?? this.commandProject;
  }

  public projectForSources(sources: readonly string[]): AllowedProject {
    for (const source of sources) {
      if (!source.startsWith('local:')) continue;
      const localPath = source.slice('local:'.length);
      const project = [...this.projects, ...this.uploadedProjects.values()]
        .find((candidate) => candidate.realPath === localPath);
      if (project !== undefined) return project;
    }
    return this.defaultProject();
  }

  public pinSources(sourceIds: readonly string[], ownerUserId: string): () => void {
    const uploadIds = [...new Set(sourceIds.flatMap((sourceId) =>
      sourceId.startsWith('upload:') ? [sourceId.slice('upload:'.length)] : []))];
    for (const id of uploadIds) {
      const project = this.uploadedProjects.get(id);
      if (project === undefined || project.ownerUserId !== ownerUserId) {
        throw new Error('사용할 수 없는 업로드 프로젝트입니다.');
      }
    }
    for (const id of uploadIds) {
      const timer = this.uploadExpirationTimers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      this.uploadExpirationTimers.delete(id);
      this.uploadPins.set(id, (this.uploadPins.get(id) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of uploadIds) {
        const count = this.uploadPins.get(id) ?? 0;
        if (count > 1) {
          this.uploadPins.set(id, count - 1);
          continue;
        }
        this.uploadPins.delete(id);
        const project = this.uploadedProjects.get(id);
        if (project !== undefined) {
          project.expiresAt = Date.now() + UPLOAD_TTL_MS;
          this.scheduleUploadExpiration(project);
        }
      }
    };
  }

  public async resolveManifest(projectId: string, manifest: string): Promise<{ project: AllowedProject; path: string }> {
    const project = await this.resolveProject(projectId);
    if (!project.manifests.includes(manifest)) throw new Error('허용되지 않은 manifest입니다.');
    const manifestPath = await realpath(path.join(project.realPath, manifest));
    if (!isInside(project.realPath, manifestPath)) throw new Error('프로젝트 외부 manifest는 사용할 수 없습니다.');
    return { project, path: manifestPath };
  }

  public async resolveSource(sourceId: string, ownerUserId?: string): Promise<string> {
    if (sourceId.startsWith('project:')) {
      const project = await this.resolveProject(sourceId.slice('project:'.length));
      return `local:${project.realPath}`;
    }
    if (sourceId.startsWith('upload:')) {
      this.removeExpiredUploads();
      const id = sourceId.slice('upload:'.length);
      const project = this.uploadedProjects.get(id);
      if (project === undefined || ownerUserId === undefined || project.ownerUserId !== ownerUserId) {
        throw new Error('사용할 수 없는 업로드 프로젝트입니다.');
      }
      project.expiresAt = Date.now() + UPLOAD_TTL_MS;
      this.scheduleUploadExpiration(project);
      return `local:${project.realPath}`;
    }
    if (sourceId.startsWith('org:')) {
      const alias = sourceId.slice('org:'.length);
      const orgs = await this.listOrgs();
      if (!orgs.some((org) => org.alias === alias && org.connected)) {
        throw new Error('연결된 Salesforce org가 아닙니다.');
      }
      return `org:${alias}`;
    }
    throw new Error('지원하지 않는 비교 소스입니다.');
  }

  public publicSource(source: string): { id: string; kind: 'org' | 'local'; label: string } {
    if (source.startsWith('org:')) {
      const alias = source.slice('org:'.length);
      return { id: source, kind: 'org', label: alias };
    }
    if (source.startsWith('local:')) {
      const realPath = source.slice('local:'.length);
      const project = this.projects.find((candidate) => candidate.realPath === realPath);
      if (project !== undefined) {
        return { id: `project:${project.id}`, kind: 'local', label: project.displayName };
      }
      const upload = [...this.uploadedProjects.values()].find((candidate) => candidate.realPath === realPath);
      if (upload !== undefined) {
        return { id: `upload:${upload.id}`, kind: 'local', label: upload.displayName };
      }
      if (isInside(this.uploadRoot, realPath) || isUploadStoragePath(realPath)) {
        return { id: 'upload:expired', kind: 'local', label: '만료된 업로드 프로젝트' };
      }
    }
    return { id: 'unknown', kind: 'local', label: '허용 목록 외 프로젝트' };
  }

  public publicManifest(projectPath: string, manifestPath: string): string {
    const project = [...this.projects, ...this.uploadedProjects.values()].find((candidate) =>
      candidate.realPath === projectPath || isInside(candidate.realPath, manifestPath));
    return project === undefined ? path.basename(manifestPath) : path.relative(project.realPath, manifestPath);
  }

  private removeExpiredUploads(): void {
    const now = Date.now();
    for (const [id, project] of this.uploadedProjects) {
      if (project.expiresAt <= now && (this.uploadPins.get(id) ?? 0) === 0) {
        void this.discardProjectUpload(id);
      }
    }
  }

  private scheduleUploadExpiration(project: UploadedProject): void {
    const current = this.uploadExpirationTimers.get(project.id);
    if (current !== undefined) clearTimeout(current);
    if ((this.uploadPins.get(project.id) ?? 0) > 0) {
      this.uploadExpirationTimers.delete(project.id);
      return;
    }
    const timer = setTimeout(() => {
      void this.discardProjectUpload(project.id).catch(() => undefined);
    }, Math.max(0, project.expiresAt - Date.now()));
    timer.unref();
    this.uploadExpirationTimers.set(project.id, timer);
  }
}

async function validatePackageDirectories(projectPath: string, configurationPath: string): Promise<void> {
  const [configurationRealPath, expectedRealPath] = await Promise.all([
    realpath(configurationPath),
    realpath(path.join(projectPath, 'sfdx-project.json')),
  ]);
  if (!samePath(configurationRealPath, expectedRealPath)) {
    throw new Error('sfdx-project.json 경로가 올바르지 않습니다.');
  }
  await resolveLocalPackageDirectories(projectPath);
}

async function listLocalApexTestClasses(projectPath: string): Promise<string[]> {
  const packageDirectories = await resolveLocalPackageDirectories(projectPath);
  const names: string[] = [];
  for (const directory of packageDirectories) {
    for (const relativePath of await listFiles(directory)) {
      const match = relativePath.match(/(?:^|\/)classes\/([^/]+)\.cls$/iu);
      if (match?.[1] !== undefined) names.push(match[1]);
    }
  }
  return normalizeApexClassCandidates(names);
}

function normalizeApexClassCandidates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)))].sort((left, right) => left.localeCompare(right));
}

function normalizeUploadLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  if (label === undefined || label.length === 0) return undefined;
  if (label.length > 80 || /[\u0000-\u001f]/u.test(label)) throw new Error('업로드 프로젝트 이름이 올바르지 않습니다.');
  return label;
}

function assertUploadId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error('업로드 프로젝트 식별자가 올바르지 않습니다.');
  }
}

export async function findManifests(projectPath: string): Promise<string[]> {
  const manifestDirectory = path.join(projectPath, 'manifest');
  try {
    const entries = await readdir(manifestDirectory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
      .map((entry) => path.relative(projectPath, path.join(entry.parentPath, entry.name)))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function scavengeStaleUploadRoots(
  temporaryDirectory = os.tmpdir(),
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(temporaryDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^sfud-uploads-(?:\d+-)?[A-Za-z0-9_-]+$/u.test(entry.name)) {
      continue;
    }
    const candidate = path.join(temporaryDirectory, entry.name);
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory()
        || (process.platform !== 'win32' && (candidateStat.mode & 0o777) !== 0o700)
        || (typeof process.getuid === 'function' && candidateStat.uid !== process.getuid())
        || now - candidateStat.mtimeMs <= UPLOAD_TTL_MS) {
        continue;
      }
      const pid = Number(entry.name.match(/^sfud-uploads-(\d+)-/u)?.[1]);
      if (Number.isInteger(pid) && pid > 0 && processExists(pid)) continue;
      const resolved = await realpath(candidate);
      if (path.dirname(resolved) !== await realpath(temporaryDirectory)) continue;
      await rm(resolved, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return removed;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isUploadStoragePath(candidate: string): boolean {
  const relative = path.relative(os.tmpdir(), candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0]?.startsWith('sfud-uploads-') === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeInstanceUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/u, '');
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function configuredQuota(value: number | undefined, environmentValue: string | undefined, fallback: number): number {
  const quota = value ?? (environmentValue === undefined ? fallback : Number(environmentValue));
  if (!Number.isSafeInteger(quota) || quota < 1) throw new Error('업로드 quota는 1 이상의 정수여야 합니다.');
  return quota;
}

export class UploadQuotaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UploadQuotaError';
  }
}

export function maskOrgId(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 3)}…` : `${value.slice(0, 5)}…${value.slice(-3)}`;
}
