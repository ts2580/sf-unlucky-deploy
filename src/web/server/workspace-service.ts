import { createHash } from 'node:crypto';
import { access, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SfClient } from '../../salesforce/sf-client.js';

export interface WorkspaceOrg {
  id: string;
  alias: string;
  label: string;
  edition?: string;
  connected: boolean;
}

export interface WorkspaceProject {
  id: string;
  displayName: string;
  manifests: string[];
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
}

export class WorkspaceService {
  private orgCache: { expiresAt: number; value: WorkspaceOrg[] } | undefined;
  private orgRequest: Promise<WorkspaceOrg[]> | undefined;

  private constructor(
    private readonly sfClient: SfClient,
    private readonly projects: AllowedProject[],
  ) {}

  public static async create(sfClient: SfClient, cwd: string, configuredPaths: string[]): Promise<WorkspaceService> {
    const candidates = configuredPaths.length === 0 ? [cwd] : configuredPaths;
    const projects: AllowedProject[] = [];
    for (const candidate of candidates) {
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
    if (projects.length === 0) throw new Error('허용된 Salesforce DX 프로젝트가 없습니다.');
    return new WorkspaceService(sfClient, projects);
  }

  public listProjects(): WorkspaceProject[] {
    return this.projects.map(({ id, displayName, manifests }) => ({ id, displayName, manifests }));
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

  private async loadOrgs(): Promise<WorkspaceOrg[]> {
    const raw = await this.sfClient.runJson(['org', 'list'], { cwd: this.projects[0]!.realPath, timeoutMs: 30_000 });
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
        });
      }
    }
    return [...unique.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  }

  public async resolveProject(projectId: string): Promise<AllowedProject> {
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error('허용되지 않은 Salesforce DX 프로젝트입니다.');
    return project;
  }

  public async resolveManifest(projectId: string, manifest: string): Promise<{ project: AllowedProject; path: string }> {
    const project = await this.resolveProject(projectId);
    if (!project.manifests.includes(manifest)) throw new Error('허용되지 않은 manifest입니다.');
    const manifestPath = await realpath(path.join(project.realPath, manifest));
    if (!isInside(project.realPath, manifestPath)) throw new Error('프로젝트 외부 manifest는 사용할 수 없습니다.');
    return { project, path: manifestPath };
  }

  public async resolveSource(sourceId: string): Promise<string> {
    if (sourceId.startsWith('project:')) {
      const project = await this.resolveProject(sourceId.slice('project:'.length));
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
    }
    return { id: 'unknown', kind: 'local', label: '허용 목록 외 프로젝트' };
  }

  public publicManifest(projectPath: string, manifestPath: string): string {
    const project = this.projects.find((candidate) =>
      candidate.realPath === projectPath || isInside(candidate.realPath, manifestPath));
    return project === undefined ? path.basename(manifestPath) : path.relative(project.realPath, manifestPath);
  }
}

async function findManifests(projectPath: string): Promise<string[]> {
  const manifestDirectory = path.join(projectPath, 'manifest');
  try {
    const entries = await readdir(manifestDirectory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
      .map((entry) => path.relative(projectPath, path.join(entry.parentPath, entry.name)))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
