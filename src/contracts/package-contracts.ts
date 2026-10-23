export interface InstalledPackage {
  id: string;
  name: string;
  namespace: string | null;
  orgAliases: string[];
  versionIds?: Record<string, string>;
  componentCount?: number;
  exclusionUnavailableReason?: string;
}

export interface PackageComponent { type: string; fullName: string }
export interface LoadedPackage { package: InstalledPackage; components: PackageComponent[] }
