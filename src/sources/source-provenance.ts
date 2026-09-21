import type { WorkspaceSource } from '../api/workspace-contracts.js';

// Public, immutable source metadata copied into each job. No physical paths or
// credentials belong here; this survives expiry of the temporary import.
export interface JobSourceSnapshot {
  left?: WorkspaceSource;
  right?: WorkspaceSource;
  source?: WorkspaceSource;
  project?: WorkspaceSource;
  manifest?: string;
}
