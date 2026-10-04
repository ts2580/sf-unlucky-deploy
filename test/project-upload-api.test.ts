import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';
import { createWebServer } from '../src/web/server/app.js';

const TOMBSTONE = '/api/v1/uploads/projects';

describe('제거된 프로젝트 업로드 API', { timeout: 30_000 }, () => {
  it('인증·CSRF 검증 뒤 POST는 multipart 본문을 읽지 않고 410을 반환한다', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.server.hasContentTypeParser('multipart/form-data')).toBe(false);
      const unauthenticated = await fixture.server.inject({
        method: 'POST', url: TOMBSTONE,
        headers: { 'content-type': 'multipart/form-data; boundary=broken' },
        payload: Buffer.from('not a multipart body'),
      });
      expect(unauthenticated.statusCode).toBe(401);

      const auth = await bootstrap(fixture.server);
      const csrfMissing = await fixture.server.inject({
        method: 'POST', url: TOMBSTONE,
        headers: { cookie: auth.cookie, 'content-type': 'multipart/form-data; boundary=broken' },
        payload: Buffer.from('not a multipart body'),
      });
      expect(csrfMissing.statusCode).toBe(403);

      const removed = await fixture.server.inject({
        method: 'POST', url: TOMBSTONE,
        headers: {
          cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken,
          'content-type': 'multipart/form-data; boundary=broken',
        },
        payload: Buffer.from('this body is intentionally malformed and must not be parsed'),
      });
      expect(removed.statusCode).toBe(410);
      expect(removed.json()).toMatchObject({ error: { code: 'PROJECT_UPLOAD_REMOVED' } });
      const oversized = await fixture.server.inject({
        method: 'POST', url: TOMBSTONE,
        headers: {
          cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken,
          'content-type': 'multipart/form-data; boundary=broken',
        },
        payload: Buffer.alloc(2 * 1024 * 1024, 0x78),
      });
      expect(oversized.statusCode).toBe(410);
      expect(oversized.json()).toMatchObject({ error: { code: 'PROJECT_UPLOAD_REMOVED' } });
      expect(await fixture.server.sfudRuntime.workspace.managedProjects.list()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('DELETE도 인증·CSRF·role을 먼저 검사하고 항상 제거 tombstone을 반환한다', async () => {
    const fixture = await createFixture();
    try {
      const auth = await bootstrap(fixture.server);
      const missingCsrf = await fixture.server.inject({
        method: 'DELETE', url: `${TOMBSTONE}/arbitrary-id`, headers: { cookie: auth.cookie },
      });
      expect(missingCsrf.statusCode).toBe(403);

      const removed = await fixture.server.inject({
        method: 'DELETE', url: `${TOMBSTONE}/arbitrary-id`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(removed.statusCode).toBe(410);
      expect(removed.json()).toMatchObject({ error: { code: 'PROJECT_UPLOAD_REMOVED' } });

      await fixture.server.sfudRuntime.store.database.run(
        "UPDATE users SET role = 'VIEWER' WHERE id = ?", auth.userId,
      );
      const viewer = await fixture.server.inject({
        method: 'DELETE', url: `${TOMBSTONE}/arbitrary-id`,
        headers: { cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken },
      });
      expect(viewer.statusCode).toBe(403);
      const viewerPost = await fixture.server.inject({
        method: 'POST', url: TOMBSTONE,
        headers: {
          cookie: auth.cookie, 'x-sfud-csrf': auth.csrfToken,
          'content-type': 'multipart/form-data; boundary=broken',
        },
        payload: Buffer.from('viewer body must not be parsed'),
      });
      expect(viewerPost.statusCode).toBe(403);
    } finally {
      await fixture.close();
    }
  });
});

class TombstoneSfClient implements SfClient {
  public async runJson(_args: readonly string[], _options: SfRunOptions): Promise<unknown> {
    return { result: { nonScratchOrgs: [] } };
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-project-upload-removed-'));
  const server = await createWebServer({
    host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
    databasePath: path.join(root, 'data', 'sfud.db'),
    bootstrapToken: 'upload-removed-bootstrap', sfClient: new TombstoneSfClient(),
  });
  return {
    server,
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function bootstrap(server: Awaited<ReturnType<typeof createWebServer>>) {
  const response = await server.inject({
    method: 'POST', url: '/api/v1/auth/bootstrap',
    payload: {
      bootstrapToken: 'upload-removed-bootstrap', email: 'upload-removed@example.com',
      displayName: '업로드 제거 테스트', password: 'project upload removed password',
    },
  });
  expect(response.statusCode).toBe(201);
  return {
    cookie: (response.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; '),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
    userId: response.json<{ user: { id: string } }>().user.id,
  };
}
