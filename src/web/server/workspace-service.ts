import type { GitRegistrationService } from '../../git/git-registration-service.js';
import { gitMetadataTypes } from '../../api/git-metadata-types.js';
import { requireGitMetadataType } from '../../git/git-metadata-selection.js';
import type { GitImportService } from '../../git/git-import-service.js';
import { createHash } from 'node:crypto';
import type { WorkspaceProject, WorkspaceSource } from '../../api/workspace-contracts.js';
import { ManagedProjectService } from './managed-project-service.js';
import { access, chmod, lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listFiles } from '../../core/files.js';
import { readProjectApiVersion, withRequestWorkspace } from '../../core/request-workspace.js';
import type { SfClient } from '../../salesforce/sf-client.js';
import type { OrgIdentitySnapshot } from '../../deploy/org-identity.js';
import { discoverLocalMetadataTypes, resolveLocalPackageDirectories } from '../../metadata/local-metadata.js';

const IMPORT_TTL_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_USER_IMPORT_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_SERVER_IMPORT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface WorkspaceServiceOptions {
  userImportQuotaBytes?: number;
  serverImportQuotaBytes?: number;
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
  public gitImports?: GitImportService;
  public gitRegistrations?: GitRegistrationService;
  private orgCache: { expiresAt: number; value: WorkspaceOrg[] } | undefined;
  private orgRequest: Promise<WorkspaceOrg[]> | undefined;
  private readonly metadataTypeCache = new Map<string, { expiresAt: number; value: WorkspaceMetadataType[] }>();
  private readonly metadataTypeRequests = new Map<string, Promise<WorkspaceMetadataType[]>>();
  private readonly apexTestClassCache = new Map<string, { expiresAt: number; value: string[] }>();
  private readonly apexTestClassRequests = new Map<string, Promise<string[]>>();

  private constructor(
    private readonly sfClient: SfClient,
    private readonly projects: AllowedProject[],
    private readonly commandProject: AllowedProject,
    private readonly importRoot: string,
    public readonly managedProjects: ManagedProjectService,
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
    await scavengeStaleProjectRoots();
    const createdImportRoot = await mkdtemp(path.join(os.tmpdir(), `sfud-imports-${process.pid}-`));
    await chmod(createdImportRoot, 0o700);
    const importRoot = await realpath(createdImportRoot);
    return new WorkspaceService(sfClient, projects, {
      id: 'command-workspace',
      displayName: 'sfud command workspace',
      realPath: commandProjectPath,
      manifests: [],
    }, importRoot, new ManagedProjectService(importRoot,
    configuredQuota(
      options.userImportQuotaBytes,
      process.env.SFUD_USER_IMPORT_QUOTA_BYTES ?? process.env.SFUD_USER_UPLOAD_QUOTA_BYTES,
      DEFAULT_USER_IMPORT_QUOTA_BYTES,
    ),
    configuredQuota(
      options.serverImportQuotaBytes,
      process.env.SFUD_SERVER_IMPORT_QUOTA_BYTES ?? process.env.SFUD_SERVER_UPLOAD_QUOTA_BYTES,
      DEFAULT_SERVER_IMPORT_QUOTA_BYTES,
    ), IMPORT_TTL_MS, 'Git 프로젝트'));
  }

  public listProjects(): WorkspaceProject[] {
    return this.projects.map(({ id, displayName, manifests }) => ({ id, displayName, manifests }));
  }

  public async close(): Promise<void> {
    await this.managedProjects.close();
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
    const registered = sourceIds.filter((id) => id.startsWith('git-registered:'));
    for (const id of registered) {
      if (ownerUserId === undefined || this.gitRegistrations === undefined) throw new Error('등록 브랜치를 사용할 수 없습니다.');
      await this.gitRegistrations.get(id.slice('git-registered:'.length), ownerUserId);
    }
    const resolvedSources = await Promise.all(sourceIds.filter((id) => !id.startsWith('git-registered:')).map((sourceId) =>
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
    if (registered.length > 0) for (const type of gitMetadataTypes) unique.set(type.name, { name: type.name, directoryName: type.directoryName });
    for (const value of values.flat()) unique.set(value.name, value);
    // An explicitly fetched type remains a valid (possibly empty) source. This
    // permits meaningful comparisons against components only present in target.
    for (const source of resolvedSources) {
      const name = this.publicSource(source).provenance?.metadataType;
      if (name !== undefined) {
        const type = requireGitMetadataType(name);
        unique.set(name, { name, directoryName: type.directoryName });
      }
    }
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

  public async resolveProject(projectId: string, ownerUserId?: string): Promise<AllowedProject> {
    if (projectId.startsWith('git:')) {
      if (this.gitImports === undefined) throw new Error('Git 프로젝트를 사용할 수 없습니다.');
      return this.gitImports.resolve(projectId.slice(4), ownerUserId);
    }
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
      const project = [...this.projects, ...this.managedProjects.list()]
        .find((candidate) => candidate.realPath === localPath);
      if (project !== undefined) return project;
    }
    return this.defaultProject();
  }

  public pinSources(sourceIds: readonly string[], ownerUserId: string): () => void {
    const managedIds = sourceIds.flatMap((sourceId) =>
      sourceId.startsWith('git:') ? [sourceId.slice(sourceId.indexOf(':') + 1)] : []);
    return this.managedProjects.pin(managedIds, ownerUserId);
  }

  public async resolveManifest(projectId: string, manifest: string, ownerUserId?: string): Promise<{ project: AllowedProject; path: string }> {
    const project = await this.resolveProject(projectId, ownerUserId);
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
    if (sourceId.startsWith('git:')) {
      const project = await this.resolveProject(sourceId, ownerUserId);
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

  public async resolveSourceSnapshot(sourceId: string, ownerUserId?: string): Promise<{ source: string; snapshot: WorkspaceSource }> {
    const source = await this.resolveSource(sourceId, ownerUserId);
    return { source, snapshot: structuredClone(this.publicSource(source)) };
  }

  public publicSource(source: string): WorkspaceSource {
    if (source.startsWith('org:')) {
      const alias = source.slice('org:'.length);
      return { id: source, kind: 'org', label: alias };
    }
    if (source.startsWith('local:')) {
      const realPath = source.slice('local:'.length);
      const gitSource = this.gitImports?.sourceForPath(realPath);
      if (gitSource !== undefined) return gitSource;
      const project = this.projects.find((candidate) => candidate.realPath === realPath);
      if (project !== undefined) {
        return { id: `project:${project.id}`, kind: 'local', label: project.displayName };
      }
      // Retain redacted labels for historical jobs after temporary storage expires.
      if (isManagedStoragePath(realPath, 'uploads')) {
        return { id: 'upload:expired', kind: 'local', label: '만료된 업로드 프로젝트' };
      }
      if (isInside(this.importRoot, realPath) || isManagedStoragePath(realPath, 'imports')) {
        return { id: 'git:expired', kind: 'local', label: '만료된 Git 프로젝트' };
      }
    }
    return { id: 'unknown', kind: 'local', label: '허용 목록 외 프로젝트' };
  }

  public publicManifest(projectPath: string, manifestPath: string): string {
    const project = [...this.projects, ...this.managedProjects.list()].find((candidate) =>
      candidate.realPath === projectPath || isInside(candidate.realPath, manifestPath));
    return project === undefined ? path.basename(manifestPath) : path.relative(project.realPath, manifestPath);
  }

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

async function findManifests(projectPath: string): Promise<string[]> {
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

export async function scavengeStaleProjectRoots(
  temporaryDirectory = os.tmpdir(),
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(temporaryDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^sfud-(?:imports|uploads)-(?:\d+-)?[A-Za-z0-9_-]+$/u.test(entry.name)) {
      continue;
    }
    const candidate = path.join(temporaryDirectory, entry.name);
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory()
        || (process.platform !== 'win32' && (candidateStat.mode & 0o777) !== 0o700)
        || (typeof process.getuid === 'function' && candidateStat.uid !== process.getuid())
        || now - candidateStat.mtimeMs <= IMPORT_TTL_MS) {
        continue;
      }
      const pid = Number(entry.name.match(/^sfud-(?:imports|uploads)-(\d+)-/u)?.[1]);
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

function isManagedStoragePath(candidate: string, kind: 'imports' | 'uploads'): boolean {
  const relative = path.relative(os.tmpdir(), candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0]?.startsWith(`sfud-${kind}-`) === true;
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
  if (!Number.isSafeInteger(quota) || quota < 1) throw new Error('Git 가져오기 quota는 1 이상의 정수여야 합니다.');
  return quota;
}

export function maskOrgId(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 3)}…` : `${value.slice(0, 5)}…${value.slice(-3)}`;
}
