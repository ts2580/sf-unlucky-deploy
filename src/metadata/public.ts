/** Explicit module entry point. Keep implementation imports inside this module. */
export { type ComparisonResult, type ComparisonSummary, type ComponentDifference, type DifferenceStatus, type FileDifference, compareSnapshots } from './comparator.js';
export { generateDeployableManifest } from './deployable-manifest.js';
export { discoverLocalMetadataTypes, resolveLocalPackageDirectories } from './local-metadata.js';
export { retrievePackageComponents } from './package-components.js';
export { type PackageComponentResolver, listInstalledPackages, resolvePackageExclusion, validateExcludedPackageIds } from './package-exclusion.js';
export { type SelectedMetadataComponent, normalizeSelectedComponents, writeSelectedManifest } from './selected-manifest.js';
export { type XmlChange } from './xml-diff.js';
