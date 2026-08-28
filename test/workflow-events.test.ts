import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebServer } from '../src/web/server/app.js';
import { WorkflowEventHub } from '../src/web/server/workflow-events.js';

const servers: Awaited<ReturnType<typeof createWebServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('작업 현황 SSE', () => {
  it('구독자에게 순번이 있는 작업 상태 변경을 전달한다', () => {
    const hub = new WorkflowEventHub();
    const received: unknown[] = [];
    const unsubscribe = hub.subscribe((event) => received.push(event));

    hub.publish({
      resource: 'deployment', jobId: 'dry-run-1', kind: 'DRY_RUN',
      status: 'DRY_RUN_RUNNING', updatedAt: '2026-08-28T00:00:00.000Z',
    });
    unsubscribe();
    hub.publish({
      resource: 'deployment', jobId: 'dry-run-1', kind: 'DRY_RUN',
      status: 'APPROVAL_PENDING', updatedAt: '2026-08-28T00:00:01.000Z',
    });

    expect(received).toEqual([expect.objectContaining({
      id: 1, resource: 'deployment', jobId: 'dry-run-1', status: 'DRY_RUN_RUNNING',
    })]);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('끊어진 구독자의 오류가 작업 상태 저장을 방해하지 않는다', () => {
    const hub = new WorkflowEventHub();
    const received: string[] = [];
    hub.subscribe(() => { throw new Error('closed stream'); });
    hub.subscribe((event) => received.push(event.status));

    expect(() => hub.publish({
      resource: 'comparison', jobId: 'compare-1', kind: 'COMPARE',
      status: 'SUCCEEDED', updatedAt: '2026-08-28T00:00:00.000Z',
    })).not.toThrow();
    expect(received).toEqual(['SUCCEEDED']);
    expect(hub.subscriberCount()).toBe(1);
  });

  it('인증된 브라우저에 text/event-stream으로 상태를 전송한다', async () => {
    const server = await createWebServer({
      host: '127.0.0.1', port: 0, assetsDirectory: '/missing', databasePath: ':memory:',
      bootstrapToken: 'workflow-events-bootstrap-token',
    });
    servers.push(server);
    expect((await server.inject('/api/v1/workflow/events')).statusCode).toBe(401);

    const bootstrap = await server.inject({
      method: 'POST', url: '/api/v1/auth/bootstrap',
      payload: {
        bootstrapToken: 'workflow-events-bootstrap-token', email: 'events@example.com',
        displayName: '이벤트 관리자', password: 'workflow events password',
      },
    });
    const cookie = (bootstrap.headers['set-cookie'] as string[])
      .map((value) => value.split(';')[0]).join('; ');
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/workflow/events`, {
      headers: { cookie }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(server.sfudRuntime.workflowEvents.subscriberCount()).toBe(1);

    const job = await server.sfudRuntime.deploymentJobs.createDryRun({
      source: 'local:fixture', targetAlias: 'target', manifestPath: 'generated/package.xml',
      payloadChecksum: 'a'.repeat(64),
    });
    const reader = response.body!.getReader();
    let stream = '';
    while (!stream.includes(`"jobId":"${job.id}"`)) {
      const chunk = await Promise.race([
        reader.read(),
        delay(2_000).then(() => { throw new Error('SSE 상태 이벤트 대기 시간이 초과되었습니다.'); }),
      ]);
      if (chunk.done) break;
      stream += new TextDecoder().decode(chunk.value);
    }
    expect(stream).toContain('event: ready');
    expect(stream).toContain('event: workflow');
    expect(stream).toContain('"resource":"deployment"');
    expect(stream).toContain('"status":"QUEUED"');

    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
