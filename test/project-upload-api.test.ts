import { access, chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';
import { findManifests, scavengeStaleUploadRoots } from '../src/web/server/workspace-service.js';

const PROJECT_UPLOAD_INTEGRATION_TIMEOUT_MS = 30_000;

describe('프로젝트 업로드 API', { timeout: PROJECT_UPLOAD_INTEGRATION_TIMEOUT_MS }, () => {
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
      expect(response.statusCode, response.body).toBe(201);
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

      for (const unsafePath of [
        'project/Node_Modules/dependency.js',
        'project/CON.txt',
        'project/classes/Name.cls:secret',
        'project/classes/trailing. ',
      ]) {
        const unsafe = await upload(fixture.server, auth, [
          ['project/sfdx-project.json', '{"packageDirectories":[{"path":"force-app"}]}'],
          [unsafePath, 'unsafe'],
        ]);
        expect(unsafe.statusCode).toBe(400);
        expect(unsafe.json()).toMatchObject({ error: { code: 'INVALID_PROJECT_UPLOAD' } });
      }
    } finally {
      await fixture.close();
    }
  });

  it('사용자별 및 서버 전체 업로드 quota를 초과하면 부분 업로드를 제거한다', async () => {
    for (const limits of [
      { userUploadQuotaBytes: 350, serverUploadQuotaBytes: 1_000, message: '사용자별' },
      { userUploadQuotaBytes: 1_000, serverUploadQuotaBytes: 350, message: '서버 전체' },
    ]) {
      const fixture = await createFixture(limits);
      try {
        const auth = await bootstrap(fixture.server);
        const files: Array<[string, string]> = [
          ['project/sfdx-project.json', '{"packageDirectories":[{"path":"force-app"}]}'],
          ['project/force-app/payload.txt', 'x'.repeat(240)],
        ];
        const accepted = await upload(fixture.server, auth, files);
        expect(accepted.statusCode, accepted.body).toBe(201);
        const rejected = await upload(fixture.server, auth, files);
        expect(rejected.statusCode).toBe(413);
        expect(rejected.json()).toMatchObject({ error: {
          code: 'PROJECT_UPLOAD_QUOTA_EXCEEDED',
          message: expect.stringContaining(limits.message),
        } });
        expect((await fixture.server.inject({
          url: '/api/v1/workspace', headers: { cookie: auth.cookie },
        })).json<{ uploads: unknown[] }>().uploads).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    }
  });

  it('소유권·권한·mtime을 확인해 stale upload root만 정리한다', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-upload-scavenger-'));
    try {
      const stale = path.join(temporaryDirectory, 'sfud-uploads-999999-fixture');
      const active = path.join(temporaryDirectory, `sfud-uploads-${process.pid}-fixture`);
      const unsafeMode = path.join(temporaryDirectory, 'sfud-uploads-999998-fixture');
      await Promise.all([mkdir(stale), mkdir(active), mkdir(unsafeMode)]);
      await Promise.all([chmod(stale, 0o700), chmod(active, 0o700), chmod(unsafeMode, 0o755)]);
      const old = new Date(0);
      await Promise.all([
        utimes(stale, old, old),
        utimes(active, old, old),
        utimes(unsafeMode, old, old),
      ]);

      expect(await scavengeStaleUploadRoots(temporaryDirectory, 5 * 60 * 60 * 1_000))
        .toBe(process.platform === 'win32' ? 2 : 1);
      await expect(access(stale)).rejects.toThrow();
      await expect(access(active)).resolves.toBeUndefined();
      if (process.platform === 'win32') {
        await expect(access(unsafeMode)).rejects.toThrow();
      } else {
        await expect(access(unsafeMode)).resolves.toBeUndefined();
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('manifest 디렉터리의 ENOENT만 빈 목록으로 처리한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-manifest-errors-'));
    try {
      await expect(findManifests(root)).resolves.toEqual([]);
      await writeFile(path.join(root, 'manifest'), 'not a directory');
      await expect(findManifests(root)).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally {
      await rm(root, { recursive: true, force: true });
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
        {
          alias: 'target', username: 'target@example.com', orgId: '00D000000000001',
          instanceUrl: 'https://target.example.my.salesforce.com', name: 'Target',
          orgEdition: 'Developer', connectedStatus: 'Connected',
        },
      ] } };
    }
    throw new Error(`예상하지 못한 sf 명령: ${args.join(' ')}`);
  }
}

async function createFixture(limits: {
  userUploadQuotaBytes?: number;
  serverUploadQuotaBytes?: number;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-project-upload-api-'));
  const client = new UploadSfClient();
  const server = await createWebServer({
    host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
    databasePath: path.join(root, 'data', 'sfud.db'), projectPaths: [],
    bootstrapToken: 'upload-bootstrap-token', sfClient: client,
    ...limits,
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
