import { Type, type Static } from '@sinclair/typebox';
import { WorkspaceSourceSchema } from './workspace-contracts.js';
const text = Type.String({ minLength: 1, maxLength: 200 });
export const DeploymentSelectionSchema = Type.Object({
  sourceId: text, targetId: text,
  expectedSourceIdentityFingerprint: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  expectedTargetIdentityFingerprint: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  metadataType: Type.Optional(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]*$', maxLength: 100 })),
  compareCurrentType: Type.Boolean(), showIdentical: Type.Boolean(),
  excludedPackageIds: Type.Array(text, { maxItems: 200, uniqueItems: true }),
  testLevel: Type.Union(['auto', 'NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'].map((value) => Type.Literal(value))),
  tests: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200, uniqueItems: true }),
}, { additionalProperties: false });
export const SaveDeploymentPresetSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 80, pattern: '^[^\\x00-\\x1f\\x7f]+$' }), selection: DeploymentSelectionSchema }, { additionalProperties: false });
export const DeploymentPresetSummarySchema = Type.Object({ id: text, name: Type.String(), schemaVersion: Type.Literal(1), createdAt: Type.String(), updatedAt: Type.String() }, { additionalProperties: false });
export const DeploymentPresetListSchema = Type.Object({ presets: Type.Array(DeploymentPresetSummarySchema) });
export const ResolvedDeploymentPresetSchema = Type.Object({
  preset: DeploymentPresetSummarySchema, selection: Type.Optional(DeploymentSelectionSchema),
  source: Type.Optional(WorkspaceSourceSchema), target: Type.Optional(WorkspaceSourceSchema),
  warnings: Type.Array(Type.String()),
  preparationRequired: Type.Boolean(),
}, { additionalProperties: false });
export type DeploymentSelection = Static<typeof DeploymentSelectionSchema>;
export type SaveDeploymentPreset = Static<typeof SaveDeploymentPresetSchema>;
export type DeploymentPresetSummary = Static<typeof DeploymentPresetSummarySchema>;
export type ResolvedDeploymentPreset = Static<typeof ResolvedDeploymentPresetSchema>;
