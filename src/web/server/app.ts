import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { CLI_VERSION } from '../../program.js';
import { resolveDatabasePath } from '../../storage/sqlite-store.js';
import type { DiagnosticsResponse, HealthResponse } from '../shared/api.js';
import { createWebRuntime, type WebRuntime } from './runtime.js';
import { registerAuthRoutes, requireAuthenticatedSession } from './auth-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerComparisonRoutes } from './comparison-routes.js';
import { registerDeploymentRoutes } from './deployment-routes.js';
import { registerProjectUploadRoutes } from './project-upload-routes.js';
import { registerWorkflowEventRoutes } from './workflow-events.js';
import { registerSettingsRoutes } from './settings-routes.js';
import type { SfClient } from '../../salesforce/sf-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    sfudRuntime: WebRuntime;
  }
}

export interface WebServerOptions {
  host: string;
  port: number;
  assetsDirectory?: string;
  dataDirectory?: string;
  databasePath?: string;
  logger?: boolean;
  bootstrapToken?: string;
  projectPaths?: string[];
  sfClient?: SfClient;
  trustedProxies?: string[];
  publicOrigin?: string;
  userUploadQuotaBytes?: number;
  serverUploadQuotaBytes?: number;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const trustedProxies = options.trustedProxies ?? [];
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const app = Fastify({
    logger: options.logger ?? false,
    ...(trustedProxies.length === 0 ? {} : { trustProxy: trustedProxies }),
  });
  const assetsDirectory = options.assetsDirectory ?? resolveDefaultAssetsDirectory();
  const databasePath = options.databasePath
    ?? resolveDatabasePath(process.cwd(), options.dataDirectory);
  const runtime = await createWebRuntime(
    databasePath,
    options.bootstrapToken,
    options.projectPaths,
    process.cwd(),
    options.sfClient,
    {
      ...(options.userUploadQuotaBytes === undefined
        ? {}
        : { userUploadQuotaBytes: options.userUploadQuotaBytes }),
      ...(options.serverUploadQuotaBytes === undefined
        ? {}
        : { serverUploadQuotaBytes: options.serverUploadQuotaBytes }),
    },
  );
  app.decorate('sfudRuntime', runtime);
  app.addHook('onClose', async () => {
    await runtime.shutdown();
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    if (request.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  await app.register(fastifyMultipart, {
    preservePath: true,
    throwFileSizeLimit: true,
    limits: {
      fields: 1,
      files: 2_000,
      parts: 2_001,
      fileSize: 10 * 1024 * 1024,
    },
  });

  app.get('/api/v1/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    service: 'sfud-ui',
    version: CLI_VERSION,
  }));

  app.get('/api/v1/diagnostics', async (request, reply): Promise<DiagnosticsResponse | undefined> => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;
    return {
      status: 'ok',
      service: 'sfud-ui',
      version: CLI_VERSION,
    host: options.host,
    port: options.port,
    storage: {
      engine: 'sqlite',
      status: 'ok',
    },
    queue: runtime.deploymentQueue.status(),
    comparisonQueue: runtime.comparisonQueue.status(),
    recoveredJobCount: runtime.recoveredJobCount,
    recoveredComparisonCount: runtime.recoveredComparisonCount,
    };
  });

  await registerAuthRoutes(app, publicOrigin === undefined ? {} : { publicOrigin });
  await registerAdminRoutes(app);
  await registerProjectUploadRoutes(app);
  await registerSettingsRoutes(app);
  await registerComparisonRoutes(app);
  await registerDeploymentRoutes(app);
  await registerWorkflowEventRoutes(app);

  if (await hasBuiltUi(assetsDirectory)) {
    await app.register(fastifyStatic, {
      root: assetsDirectory,
      wildcard: false,
    });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    app.get('/', async (_request, reply) => reply
      .code(503)
      .type('text/html; charset=utf-8')
      .send(renderMissingAssetsPage()));
  }

  return app;
}

function normalizePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) throw new Error('publicOrigin은 경로가 없는 http(s) origin이어야 합니다.');
  return parsed.origin;
}

export function resolveDefaultAssetsDirectory(moduleUrl = import.meta.url): string {
  return path.resolve(fileURLToPath(new URL('../../../dist/ui', moduleUrl)));
}

async function hasBuiltUi(directory: string): Promise<boolean> {
  try {
    await access(path.join(directory, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

function renderMissingAssetsPage(): string {
  return `<!doctype html>
<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>sfud UI 빌드 필요</title>
<style>body{font-family:system-ui;background:#f1f5f9;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34rem;background:white;padding:2rem;border-radius:1rem;box-shadow:0 20px 50px #0f172a18}code{background:#e2e8f0;padding:.2rem .45rem;border-radius:.35rem}</style>
<main><h1>웹 UI 자산이 없습니다.</h1><p><code>npm run build:ui</code>를 실행한 뒤 다시 시작해 주세요.</p></main></html>`;
}
