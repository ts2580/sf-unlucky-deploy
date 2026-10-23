/** Explicit module entry point. Keep implementation imports inside this module. */
export { assertGitMetadataScope } from './git-metadata-scope.js';
export { type ManagedProject, ManagedProjectQuotaError } from './managed-project-service.js';
export { type ManagedProjectStore } from './managed-project-store.js';
export { createRunContext, writeRunMetadata } from './run-context.js';
export { settledSnapshots } from './settled-snapshots.js';
export { createSnapshot } from './snapshot.js';
export { type JobSourceSnapshot, immutableSourceSnapshot } from './source-provenance.js';
export { parseSourceSpec } from './source-spec.js';
