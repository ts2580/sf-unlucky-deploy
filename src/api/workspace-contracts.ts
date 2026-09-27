import { Type, type Static } from '@sinclair/typebox';
import { GitProviderIdSchema } from './git-contracts.js';

const GitProvenanceSchema = Type.Object({
  provider: GitProviderIdSchema,
  host: Type.String(),
  repositoryId: Type.String(),
  repositoryPath: Type.String(),
  refType: Type.Union([Type.Literal('branch'), Type.Literal('tag'), Type.Literal('commit')]),
  refName: Type.String(),
  commitSha: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  projectRoot: Type.String(),
  metadataType: Type.Optional(Type.String()),
  importedAt: Type.String(),
  importedContentChecksum: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  sourceOwnerUserId: Type.String(),
  importId: Type.String(),
}, { additionalProperties: false });

export const WorkspaceSourceSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal('org'), Type.Literal('local')]),
  // 'upload' remains readable only for historical source snapshots.
  location: Type.Optional(Type.Union([
    Type.Literal('org'), Type.Literal('server'), Type.Literal('upload'), Type.Literal('git'),
  ])),
  label: Type.String(),
  detail: Type.Optional(Type.String()),
  username: Type.Optional(Type.String()),
  maskedOrgId: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.String()),
  provenance: Type.Optional(GitProvenanceSchema),
}, { additionalProperties: false });

const WorkspaceProjectSchema = Type.Object({
  id: Type.String(), displayName: Type.String(), manifests: Type.Array(Type.String()),
}, { additionalProperties: false });

export const WorkspaceResponseSchema = Type.Object({
  sources: Type.Array(WorkspaceSourceSchema),
  projects: Type.Array(WorkspaceProjectSchema),
  orgs: Type.Optional(Type.Array(Type.Object({
    id: Type.String(), alias: Type.String(), label: Type.String(), connected: Type.Boolean(),
    edition: Type.Optional(Type.String()), username: Type.Optional(Type.String()),
    maskedOrgId: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
}, { additionalProperties: false });

export type WorkspaceSource = Static<typeof WorkspaceSourceSchema>;
export type WorkspaceProject = Static<typeof WorkspaceProjectSchema>;
export type WorkspaceResponse = Static<typeof WorkspaceResponseSchema>;
