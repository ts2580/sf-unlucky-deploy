import { Type, type Static } from '@sinclair/typebox';

export const GitProviderIdSchema = Type.Union([Type.Literal('github'), Type.Literal('gitlab'), Type.Literal('bitbucket')]);
const GitConnectionSchema = Type.Object({
  id: Type.String(), provider: GitProviderIdSchema, providerHost: Type.String(), providerAccountId: Type.String(),
  displayName: Type.String(), expiresAt: Type.Optional(Type.String()), grantedPermissions: Type.Array(Type.String()),
  repositoryPath: Type.Optional(Type.String()),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('REAUTH_REQUIRED'), Type.Literal('REVOKED')]),
  createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false });
export const GitConnectionListResponseSchema = Type.Object({
  connections: Type.Array(GitConnectionSchema),
  tokenStorage: Type.Union([Type.Literal('ready'), Type.Literal('not_configured'), Type.Literal('invalid_key')]),
}, { additionalProperties: false });
export const GitProvidersResponseSchema = Type.Object({
  environmentAvailable: Type.Optional(Type.Boolean()),
  providers: Type.Array(Type.Object({ id: GitProviderIdSchema, configured: Type.Boolean(), publicImport: Type.Boolean(), privateImport: Type.Boolean() }, { additionalProperties: false })),
  tokenStorage: GitConnectionListResponseSchema.properties.tokenStorage,
}, { additionalProperties: false });
export type GitConnectionListResponse = Static<typeof GitConnectionListResponseSchema>;
export type GitProvidersResponse = Static<typeof GitProvidersResponseSchema>;
export type GitConnection = GitConnectionListResponse['connections'][number];
export type GitProviderId = Static<typeof GitProviderIdSchema>;

export const GitTokenInputSchema = Type.Object({
  provider: GitProviderIdSchema,
  token: Type.String({ minLength: 1, maxLength: 16384, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$' }),
  apiUsername: Type.Optional(Type.String({ minLength: 1, maxLength: 254 })),
  expiresAt: Type.Optional(Type.String({ maxLength: 30 })),
  repositoryPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
}, { additionalProperties: false });
export type GitTokenInput = Static<typeof GitTokenInputSchema>;
export const GitConnectionResponseSchema = Type.Object({ connection: GitConnectionSchema }, { additionalProperties: false });
export const GitEnvironmentResponseSchema = Type.Object({ results: Type.Array(Type.Object({
  provider: GitProviderIdSchema, connection: Type.Optional(GitConnectionSchema), errorCode: Type.Optional(Type.String()),
}, { additionalProperties: false })) }, { additionalProperties: false });
