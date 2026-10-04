import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import { SaveDeploymentDraftSchema, DeploymentDraftSchema, DeploymentDraftListSchema, ResolvedDeploymentDraftSchema, type SaveDeploymentDraft } from '../../api/deployment-draft-contracts.js';
import { requireAuthenticatedSession } from './auth-routes.js';
import { captureSelection, resolveSavedSelection } from './deployment-selection-resolver.js';
const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
const validatorCompiler = ({ schema }: { schema: unknown }) => (data: unknown) => Value.Check(schema as TSchema, data) ? { value: data } : { error: new Error('선택 초안 요청이 계약과 일치하지 않습니다.') };
const mutation = { csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'] as ('OPERATOR' | 'DEPLOYER' | 'ADMIN')[] };
export async function registerDeploymentDraftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/deployment-drafts', { schema: { response: { 200: DeploymentDraftListSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply); if (session === undefined) return;
    return { drafts: await app.sfudRuntime.drafts.list(session.user.id) };
  });
  app.put<{ Body: SaveDeploymentDraft }>('/api/v1/deployment-drafts', { validatorCompiler, schema: { body: SaveDeploymentDraftSchema, response: { 200: DeploymentDraftSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation); if (session === undefined) return;
    try {
      // Allocate receive order before any slow identity/Git capture. Revision CAS is persisted across restarts.
      const revision = await app.sfudRuntime.drafts.reserveRevision();
      const settings = await captureSelection(app.sfudRuntime, session.user.id, request.body.selection, false);
      return await app.sfudRuntime.drafts.save(session.user.id, request.body.tabId, settings, revision);
    }
    catch { return reply.code(400).send({ error: { code: 'DRAFT_SAVE_FAILED', message: '선택 초안을 저장하지 못했습니다. 현재 연결과 초안 개수 제한을 확인하세요.' } }); }
  });
  for (const prepare of [false, true]) {
    app.route<{ Params: { id: string } }>({ method: prepare ? 'POST' : 'GET', url: `/api/v1/deployment-drafts/:id/${prepare ? 'prepare' : 'resolve'}`,
      schema: { params, response: { 200: ResolvedDeploymentDraftSchema } }, handler: async (request, reply) => {
        const session = await requireAuthenticatedSession(app, request, reply, prepare ? mutation : {}); if (session === undefined) return;
        try {
          const { draft, settings } = await app.sfudRuntime.drafts.get(session.user.id, request.params.id);
          const resolved = await resolveSavedSelection(app.sfudRuntime, session.user.id, { id: draft.id, name: '선택 초안', schemaVersion: 1, createdAt: draft.updatedAt, updatedAt: draft.updatedAt }, settings, prepare);
          return { draft, resolved };
        } catch { return reply.code(409).send({ error: { code: 'DRAFT_REVALIDATION_REQUIRED', message: '초안이 만료되었거나 저장 대상이 변경되었습니다. 대상을 다시 선택하세요.' } }); }
      },
    });
  }
  app.delete<{ Params: { id: string } }>('/api/v1/deployment-drafts/:id', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation); if (session === undefined) return;
    try { await app.sfudRuntime.drafts.remove(session.user.id, request.params.id); return reply.code(204).send(); }
    catch { return reply.code(404).send({ error: { code: 'DRAFT_NOT_FOUND', message: '선택 초안을 찾을 수 없습니다.' } }); }
  });
}
