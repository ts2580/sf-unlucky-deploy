import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';

describe('프로젝트 업로드 API', () => {
  it('실행 디렉터리를 자동 노출하지 않고 브라우저 DX 폴더만 사용자 임시 소스로 등록한다', async () => {
    const fixture = await createFixture();
    try {
      const auth = await bootstrap(fixture.server);
      const initial = await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      });
      expect(initial.json()).toMatchObject({ projects: [], uploads: [] });
      expect(initial.json<{ sources: Array<{ location: string }> }>().sources)
        .not.toContainEqual(expect.objectContaining({ location: 'server' }));

      const response = await upload(fixture.server, auth, [
        ['teacher-project/sfdx-project.json', JSON.stringify({
          packageDirectories: [{ path: 'force-app', default: true }],
          sourceApiVersion: '61.0',
        })],
        ['teacher-project/force-app/main/default/classes/Hello.cls', 'public class Hello {}\n'],
        ['teacher-project/force-app/main/default/classes/Hello.cls-meta.xml', '<ApexClass/>\n'],
      ]);
      expect(response.statusCode).toBe(201);
      const source = response.json<{ source: { id: string; location: string; label: string } }>().source;
      expect(source).toMatchObject({ location: 'upload', label: 'teacher-project' });
      expect(response.body).not.toContain('/tmp/');

      const workspace = await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      });
      expect(workspace.json()).toMatchObject({
        projects: [],
        uploads: [{ displayName: 'teacher-project' }],
        sources: [{ id: 'org:target' }, { id: source.id, location: 'upload' }],
      });
      const resolvedSource = await fixture.server.sfudRuntime.workspace.resolveSource(source.id, auth.userId);
      const uploadedPath = resolvedSource.slice('local:'.length);
      await expect(access(path.join(uploadedPath, 'sfdx-project.json'))).resolves.toBeUndefined();
      await expect(fixture.server.sfudRuntime.workspace.resolveSource(source.id, 'another-user'))
        .rejects.toThrow('사용할 수 없는 업로드 프로젝트');

      const metadataTypes = await fixture.server.inject({
        url: `/api/v1/metadata-types?sourceIds=${encodeURIComponent(`${source.id},org:target`)}`,
        headers: { cookie: auth.cookie },
      });
      expect(metadataTypes.statusCode).toBe(200);
      expect(fixture.client.calls.find((call) => call.args.includes('metadata-types'))?.args)
        .toEqual(expect.arrayContaining(['--api-version', '61.0']));

      const id = source.id.slice('upload:'.length);
      let releaseBlocker!: () => void;
      const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
      const blocker = fixture.server.sfudRuntime.comparisonQueue.enqueue('blocking-job', async () => blockerGate);
      const queued = await fixture.server.inject({
        method: 'POST', url: '/api/v1/comparisons',
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
        payload: {
          scope: 'all', metadataType: 'ApexClass', leftSourceId: 'org:target', rightSourceId: source.id,
          strict: false, showIdentical: false,
        },
      });
      expect(queued.statusCode).toBe(202);
      const pinnedDelete = await fixture.server.inject({
        method: 'DELETE', url: `/api/v1/uploads/projects/${id}`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(pinnedDelete.statusCode).toBe(404);
      expect(pinnedDelete.json()).toMatchObject({ error: {
        message: '작업에서 사용 중인 업로드 프로젝트는 제거할 수 없습니다.',
      } });
      await expect(access(uploadedPath)).resolves.toBeUndefined();

      releaseBlocker();
      await blocker;
      await fixture.server.sfudRuntime.comparisonQueue.onIdle();
      const deleted = await fixture.server.inject({
        method: 'DELETE', url: `/api/v1/uploads/projects/${id}`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(deleted.statusCode).toBe(204);
      await expect(access(uploadedPath)).rejects.toThrow();
      await expect(fixture.server.sfudRuntime.workspace.resolveSource(source.id, auth.userId))
        .rejects.toThrow('사용할 수 없는 업로드 프로젝트');
    } finally {
      await fixture.close();
    }
  });

  it('비밀 파일과 경로 탈출 시도를 업로드 전체와 함께 거부한다', async () => {
    const fixture = await createFixture();
    try {
      const auth = await bootstrap(fixture.server);
      const secret = await upload(fixture.server, auth, [
        ['project/sfdx-project.json', '{"packageDirectories":[{"path":"force-app"}]}'],
        ['project/.env', 'SF_ACCESS_TOKEN=must-not-leak'],
      ]);
      expect(secret.statusCode).toBe(400);
      expect(secret.json()).toMatchObject({ error: { code: 'INVALID_PROJECT_UPLOAD' } });
      expect(secret.body).not.toContain('must-not-leak');

      const traversal = await upload(fixture.server, auth, [
        ['../sfdx-project.json', '{"packageDirectories":[{"path":"force-app"}]}'],
      ]);
      expect(traversal.statusCode).toBe(400);
      expect((await fixture.server.inject({
        url: '/api/v1/workspace', headers: { cookie: auth.cookie },
      })).json()).toMatchObject({ uploads: [] });
    } finally {
      await fixture.close();
    }
  });
});

class UploadSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    if (args[0] === 'org' && args[1] === 'list' && args[2] === 'metadata-types') {
      return { status: 0, result: { metadataObjects: [
        { xmlName: 'ApexClass', directoryName: 'classes' },
      ] } };
    }
    if (args[0] === 'org' && args[1] === 'list') {
      return { status: 0, result: { nonScratchOrgs: [
        { alias: 'target', name: 'Target', orgEdition: 'Developer', connectedStatus: 'Connected' },
      ] } };
    }
    throw new Error(`예상하지 못한 sf 명령: ${args.join(' ')}`);
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-project-upload-api-'));
  const client = new UploadSfClient();
  const server = await createWebServer({
    host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
    databasePath: path.join(root, 'data', 'sfud.db'), projectPaths: [],
    bootstrapToken: 'upload-bootstrap-token', sfClient: client,
  });
  return {
    client,
    server,
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/bootstrap',
    payload: {
      bootstrapToken: 'upload-bootstrap-token', email: 'admin@example.com',
      displayName: '관리자', password: 'project upload password',
    },
  });
  return {
    cookie: (response.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; '),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
    userId: response.json<{ user: { id: string } }>().user.id,
  };
}

async function upload(
  server: Awaited<ReturnType<typeof createWebServer>>,
  auth: Awaited<ReturnType<typeof bootstrap>>,
  files: Array<[string, string]>,
) {
  const boundary = '----sfud-project-upload-test';
  const chunks: string[] = [
    `--${boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\nteacher-project\r\n`,
  ];
  for (const [filename, content] of files) {
    chunks.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n'
      + `${content}\r\n`,
    );
  }
  chunks.push(`--${boundary}--\r\n`);
  return server.inject({
    method: 'POST', url: '/api/v1/uploads/projects',
    headers: {
      cookie: auth.cookie,
      'x-sfud-csrf': auth.csrfToken,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.from(chunks.join('')),
  });
}
