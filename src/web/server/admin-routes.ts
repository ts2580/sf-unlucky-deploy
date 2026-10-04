import type { FastifyInstance, FastifyReply } from 'fastify';

import { UserAdministrationError } from '../../auth/auth-service.js';
import type { UserRole } from '../../storage/user-repository.js';
import { redactSensitiveText } from '../../salesforce/sf-client.js';
import { requireAuthenticatedSession } from './auth-routes.js';
import { GitAllowedIpInputSchema, GitAllowedIpListResponseSchema } from '../../api/git-contracts.js';

interface CreateUserBody {
  email?: string;
  displayName?: string;
  role?: UserRole;
  password?: string;
}

interface UpdateUserBody {
  role?: UserRole;
  disabled?: boolean;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/admin/unowned-jobs', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { roles: ['ADMIN'] });
    if (session === undefined) return;
    const jobs = await app.sfudRuntime.store.database.all<Array<{
      resource: string; id: string; created_by: string | null; status: string; created_at: string;
    }>>(`SELECT 'comparison' resource, id, created_by, status, created_at FROM comparison_jobs
      WHERE access_owner_user_id IS NULL
      UNION ALL SELECT 'deployment' resource, id, created_by, status, created_at FROM deployment_jobs
      WHERE access_owner_user_id IS NULL ORDER BY created_at DESC LIMIT 200`);
    return reply.send({ jobs: jobs.map((job) => ({ resource: job.resource, id: job.id,
      createdBy: job.created_by, status: job.status, createdAt: job.created_at })) });
  });
  app.get('/api/v1/admin/git-allowed-ips', { schema: { response: { 200: GitAllowedIpListResponseSchema } } }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { roles: ['ADMIN'] });
    if (session === undefined) return;
    return reply.send({ allowedIps: await app.sfudRuntime.gitAllowedIps.list() });
  });

  app.post<{ Body: { address: string } }>('/api/v1/admin/git-allowed-ips', {
    schema: { body: GitAllowedIpInputSchema, response: { 201: GitAllowedIpListResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { csrf: true, roles: ['ADMIN'] });
    if (session === undefined) return;
    try { return reply.code(201).send({ allowedIps: await app.sfudRuntime.gitAllowedIps.add(session.user.id, request.body.address) }); }
    catch (error) { return sendGitAllowedIpError(reply, error); }
  });

  app.delete<{ Body: { address: string } }>('/api/v1/admin/git-allowed-ips', {
    schema: { body: GitAllowedIpInputSchema, response: { 200: GitAllowedIpListResponseSchema } },
  }, async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply, { csrf: true, roles: ['ADMIN'] });
    if (session === undefined) return;
    try { return reply.send({ allowedIps: await app.sfudRuntime.gitAllowedIps.remove(session.user.id, request.body.address) }); }
    catch (error) { return sendGitAllowedIpError(reply, error); }
  });

  app.get('/api/v1/admin/users', async (request, reply) => {
    if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 사용자 관리를 사용할 수 없습니다.' } });
    const session = await requireAuthenticatedSession(app, request, reply, { roles: ['ADMIN'] });
    if (session === undefined) return;
    return reply.send({ users: (await app.sfudRuntime.auth.listUsers()).map(publicUser) });
  });

  app.post<{ Body: CreateUserBody }>('/api/v1/admin/users', async (request, reply) => {
    if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 사용자 관리를 사용할 수 없습니다.' } });
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['ADMIN'],
    });
    if (session === undefined) return;
    try {
      const user = await app.sfudRuntime.auth.createManagedUser({
        actorUserId: session.user.id,
        email: requiredString(request.body?.email, '이메일'),
        displayName: requiredString(request.body?.displayName, '표시 이름'),
        role: requiredRole(request.body?.role),
        password: requiredString(request.body?.password, '초기 비밀번호'),
      });
      return reply.code(201).send({ user: publicUser(user) });
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdateUserBody }>('/api/v1/admin/users/:id', async (request, reply) => {
    if (app.sfudRuntime.localMode) return reply.code(403).send({ error: { code: 'LOCAL_MODE', message: '로컬 모드에서는 사용자 관리를 사용할 수 없습니다.' } });
    const session = await requireAuthenticatedSession(app, request, reply, {
      csrf: true,
      roles: ['ADMIN'],
    });
    if (session === undefined) return;
    try {
      const user = await app.sfudRuntime.auth.updateManagedUser({
        actorUserId: session.user.id,
        userId: requiredString(request.params.id, '사용자 ID'),
        ...(request.body?.role === undefined ? {} : { role: requiredRole(request.body.role) }),
        ...(typeof request.body?.disabled === 'boolean' ? { disabled: request.body.disabled } : {}),
      });
      return reply.send({ user: publicUser(user) });
    } catch (error) {
      return sendAdminError(reply, error);
    }
  });
}

function sendGitAllowedIpError(reply: FastifyReply, error: unknown) {
  return reply.code(400).send({ error: {
    code: 'INVALID_GIT_ALLOWED_IP',
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
  } });
}

function publicUser(user: {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabledAt !== undefined,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}이(가) 필요합니다.`);
  return value;
}

function requiredRole(value: unknown): UserRole {
  if (typeof value !== 'string' || !['VIEWER', 'OPERATOR', 'DEPLOYER', 'ADMIN'].includes(value)) {
    throw new UserAdministrationError('INVALID_ROLE', '지원하지 않는 사용자 역할입니다.');
  }
  return value as UserRole;
}

function sendAdminError(reply: FastifyReply, error: unknown) {
  if (error instanceof UserAdministrationError) {
    const status = error.code === 'USER_NOT_FOUND' ? 404
      : ['EMAIL_EXISTS', 'LAST_ADMIN_REQUIRED', 'SELF_DISABLE_DENIED', 'SELF_ROLE_CHANGE_DENIED']
          .includes(error.code)
        ? 409
        : 400;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(400).send({ error: {
    code: 'INVALID_USER_ADMINISTRATION_REQUEST',
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
  } });
}
