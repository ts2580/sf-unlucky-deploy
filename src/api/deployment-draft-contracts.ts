import { Type, type Static } from '@sinclair/typebox';
import { DeploymentSelectionSchema, ResolvedDeploymentPresetSchema } from './deployment-preset-contracts.js';
export const SaveDeploymentDraftSchema = Type.Object({
  tabId: Type.String({ pattern: '^[a-f0-9-]{36}$' }), selection: DeploymentSelectionSchema,
}, { additionalProperties: false });
export const DeploymentDraftSchema = Type.Object({ id: Type.String(), tabId: Type.String(), expiresAt: Type.String(), updatedAt: Type.String() }, { additionalProperties: false });
export const DeploymentDraftListSchema = Type.Object({ drafts: Type.Array(DeploymentDraftSchema) });
export const ResolvedDeploymentDraftSchema = Type.Object({ draft: DeploymentDraftSchema, resolved: ResolvedDeploymentPresetSchema });
export type DeploymentDraft = Static<typeof DeploymentDraftSchema>;
export type SaveDeploymentDraft = Static<typeof SaveDeploymentDraftSchema>;
