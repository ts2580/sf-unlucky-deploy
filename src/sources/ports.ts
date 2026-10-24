import type { SourceProject as WorkspaceProject, SourceDescriptor as WorkspaceSource } from './model.js';

import type { InstalledPackage, PackageComponent } from '../contracts/package-contracts.js';
import type { OrgIdentitySnapshot } from '../salesforce/public.js';

export interface AllowedProject extends WorkspaceProject { realPath: string }
export interface WorkspaceMetadataType { name: string; directoryName: string }

export interface SourcePreparation {
  ownerUserId: string;
  scope: 'manifest' | 'all' | 'selected';
  metadataType?: string;
  sessionId: string;
  jobId: string;
  side: string;
}

/** A temporary preparation lease. discard releases it and removes only newly prepared resources. */
export interface PreparedSource {
  id: string;
  release(): void;
  discard(): Promise<void>;
}

/** Implemented by source adapters; the source module never imports their implementations. */
export interface SourceProvider {
  accepts(id: string): boolean;
  requiresPreparation(id: string): boolean;
  prepare(id: string, input: SourcePreparation): Promise<PreparedSource>;
  resolveProject(id: string, ownerUserId?: string): Promise<AllowedProject>;
  managedProjectIds(id: string): string[];
  sourceForPath(realPath: string): WorkspaceSource | undefined;
  metadataTypes(id: string, ownerUserId?: string): Promise<WorkspaceMetadataType[]>;
}

/** Capabilities consumed by comparison/deployment. No provider, session or database implementation. */
export interface WorkspacePort {
  prepareSource(id: string, input: SourcePreparation): Promise<PreparedSource>;
  resolveSource(id: string, ownerUserId?: string): Promise<string>;
  resolveSourceSnapshot(id: string, ownerUserId?: string): Promise<{ source: string; snapshot: WorkspaceSource }>;
  resolveProject(id: string, ownerUserId?: string): Promise<AllowedProject>;
  resolveManifest(id: string, manifest: string, ownerUserId?: string): Promise<{ project: AllowedProject; path: string }>;
  defaultProject(): AllowedProject;
  projectForSources(sources: readonly string[]): AllowedProject;
  pinSources(ids: readonly string[], ownerUserId: string): () => void;
  publicSource(source: string): WorkspaceSource;
  publicManifest(projectPath: string, manifestPath: string): string;
  listMetadataTypes(ids: readonly string[], ownerUserId?: string): Promise<WorkspaceMetadataType[]>;
  getOrgIdentity(alias: string, refresh?: boolean): Promise<OrgIdentitySnapshot>;
  resolvePackageComponents(entry: InstalledPackage, alias: string, cwd: string, signal: AbortSignal | undefined,
    required: boolean, ownerUserId: string): Promise<PackageComponent[] | undefined>;
}

export class SourceProviderError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); }
}
