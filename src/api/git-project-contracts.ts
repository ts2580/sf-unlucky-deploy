import { Type, type Static } from '@sinclair/typebox';
import { GitProviderIdSchema } from './git-contracts.js';
import { WorkspaceSourceSchema } from './workspace-contracts.js';

export const GitCatalogQuerySchema = Type.Object({
  namespace: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  search: Type.Optional(Type.String({ maxLength: 200 })),
}, { additionalProperties: false });
export const GitCatalogResponseSchema = Type.Object({
  namespaces: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false })),
  repositories: Type.Array(Type.Object({ repositoryId: Type.String(), repositoryPath: Type.String() }, { additionalProperties: false })),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type GitCatalogQuery = Static<typeof GitCatalogQuerySchema>;
export type GitCatalogPage = Static<typeof GitCatalogResponseSchema>;
export const GitRepositoryResponseSchema = Type.Object({ repository: Type.Object({
  provider: GitProviderIdSchema, host: Type.String(), repositoryPath: Type.String(), cloneUrl: Type.String(),
  repositoryId: Type.String(), defaultBranch: Type.Optional(Type.String()), private: Type.Boolean(),
}, { additionalProperties: false }) }, { additionalProperties: false });
export const GitRefsResponseSchema = Type.Object({
  refs: Type.Array(Type.Object({ kind: Type.Union([Type.Literal('branch'), Type.Literal('tag')]), name: Type.String(), commitSha: Type.String() }, { additionalProperties: false })),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type GitRepositoryResponse = Static<typeof GitRepositoryResponseSchema>;
export type GitRefsResponse = Static<typeof GitRefsResponseSchema>;

export const GitRepositoryRequestSchema = Type.Object({
  provider: GitProviderIdSchema,
  repositoryPath: Type.String({ minLength: 1, maxLength: 2000 }),
  connectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
}, { additionalProperties: false });
export const GitRefsRequestSchema = Type.Composite([GitRepositoryRequestSchema, Type.Object({
  kind: Type.Union([Type.Literal('branch'), Type.Literal('tag')]),
  cursor: Type.Optional(Type.String({ maxLength: 4000 })),
})], { additionalProperties: false });
export const GitImportRequestSchema = Type.Composite([GitRepositoryRequestSchema, Type.Object({
  ref: Type.Object({ kind: Type.Union([Type.Literal('branch'), Type.Literal('tag'), Type.Literal('commit')]), name: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
  expectedCommitSha: Type.String({ pattern: '^[0-9a-f]{40}$' }),
  metadataType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
})], { additionalProperties: false });
const ImportSchema = Type.Object({
  metadataType: Type.Optional(Type.String()),
  id: Type.String(), provider: GitProviderIdSchema, repositoryPath: Type.String(),
  ref: GitImportRequestSchema.properties.ref, expectedCommitSha: Type.String(),
  status: Type.String(), projectRoots: Type.Array(Type.String()), sizeBytes: Type.Number(),
  errorCode: Type.Optional(Type.String()), errorMessage: Type.Optional(Type.String()),
  createdAt: Type.String(), updatedAt: Type.String(),
  source: Type.Optional(WorkspaceSourceSchema),
}, { additionalProperties: false });
export const GitImportResponseSchema = Type.Object({ import: ImportSchema }, { additionalProperties: false });
export const GitImportListResponseSchema = Type.Object({ imports: Type.Array(ImportSchema) }, { additionalProperties: false });
export type GitRepositoryRequest = Static<typeof GitRepositoryRequestSchema>;
export type GitRefsRequest = Static<typeof GitRefsRequestSchema>;
export type GitImportRequestBody = Static<typeof GitImportRequestSchema>;
export type GitImportResponse = Static<typeof GitImportResponseSchema>;
export type GitImportListResponse = Static<typeof GitImportListResponseSchema>;
export type GitImport = GitImportResponse['import'];
