import { Value } from '@sinclair/typebox/value';
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { SaveDeploymentPresetSchema, DeploymentPresetListSchema, DeploymentPresetSummarySchema, ResolvedDeploymentPresetSchema, type SaveDeploymentPreset } from '../../api/deployment-preset-contracts.js';
import { requireAuthenticatedSession } from './auth-routes.js';
import { captureSelection, resolvePreset } from './deployment-selection-resolver.js';
const params = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
const validatorCompiler = ({ schema }: { schema: unknown }) => (data: unknown) => Value.Check(schema as TSchema, data) ? { value: data } : { error: new Error('저장 설정 요청이 계약과 일치하지 않습니다.') };
const mutation = { csrf: true, roles: ['OPERATOR', 'DEPLOYER', 'ADMIN'] as ('OPERATOR' | 'DEPLOYER' | 'ADMIN')[] };
export async function registerDeploymentPresetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/deployment-presets', { schema: { response: { 200: DeploymentPresetListSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    return { presets: await app.sfudRuntime.presets.list(session.user.id) };
  });
  app.post<{ Body: SaveDeploymentPreset }>('/api/v1/deployment-presets', { validatorCompiler, schema: { body: SaveDeploymentPresetSchema, response: { 201: DeploymentPresetSummarySchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try {
      const settings = await captureSelection(app.sfudRuntime, session.user.id, request.body.selection);
      return reply.code(201).send(await app.sfudRuntime.presets.save(session.user.id, request.body.name, settings));
    } catch { return reply.code(400).send({ error: { code: 'INVALID_PRESET', message: '설정을 저장할 수 없습니다. 연결·프로젝트·선택 범위와 개수 제한을 확인하세요.' } }); }
  });
  app.put<{ Params: { id: string }; Body: SaveDeploymentPreset }>('/api/v1/deployment-presets/:id', { validatorCompiler, schema: { params, body: SaveDeploymentPresetSchema, response: { 200: DeploymentPresetSummarySchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try {
      await app.sfudRuntime.presets.get(session.user.id, request.params.id);
      const settings = await captureSelection(app.sfudRuntime, session.user.id, request.body.selection);
      return await app.sfudRuntime.presets.save(session.user.id, request.body.name, settings, request.params.id);
    } catch { return reply.code(400).send({ error: { code: 'INVALID_PRESET', message: '저장 설정을 갱신할 수 없습니다. 소유권과 현재 연결을 확인하세요.' } }); }
  });
  app.delete<{ Params: { id: string } }>('/api/v1/deployment-presets/:id', { schema: { params } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { await app.sfudRuntime.presets.remove(session.user.id, request.params.id); return reply.code(204).send(); }
    catch { return reply.code(404).send({ error: { code: 'PRESET_NOT_FOUND', message: '저장 설정을 찾을 수 없습니다.' } }); }
  });
  app.get<{ Params: { id: string } }>('/api/v1/deployment-presets/:id/resolve', { schema: { params, response: { 200: ResolvedDeploymentPresetSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    try { return await resolvePreset(app.sfudRuntime, session.user.id, request.params.id); }
    catch { return reply.code(409).send({ error: { code: 'PRESET_REVALIDATION_REQUIRED', message: '저장 대상이 삭제되거나 변경되었습니다. 연결·Org identity·Git ref·프로젝트를 다시 확인하세요.' } }); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/deployment-presets/:id/prepare', { schema: { params, response: { 200: ResolvedDeploymentPresetSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, mutation);
    if (session === undefined) return;
    try { return await resolvePreset(app.sfudRuntime, session.user.id, request.params.id, true); }
    catch { return reply.code(409).send({ error: { code: 'PRESET_REVALIDATION_REQUIRED', message: 'Git 소스를 준비하지 못했습니다. 현재 연결·ref·프로젝트를 다시 확인하세요.' } }); }
  });
}
