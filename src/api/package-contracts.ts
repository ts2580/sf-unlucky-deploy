export interface InstalledPackage {
  id: string;
  name: string;
  namespace: string | null;
  orgAliases: string[];
  exclusionUnavailableReason?: string;
}
