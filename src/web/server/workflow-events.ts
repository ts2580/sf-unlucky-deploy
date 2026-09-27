import type { FastifyInstance } from 'fastify';

import { isRequestSessionActive, requireAuthenticatedSession } from './auth-routes.js';

export type WorkflowResource = 'comparison' | 'deployment';

export interface WorkflowEvent {
  id: number;
  resource: WorkflowResource;
  jobId: string;
  kind: string;
  status: string;
  updatedAt: string;
}

type WorkflowEventListener = (event: WorkflowEvent) => void;

export class WorkflowEventHub {
  private readonly listeners = new Set<WorkflowEventListener>();
  private nextId = 1;

  public publish(event: Omit<WorkflowEvent, 'id'>): WorkflowEvent {
    const published = { id: this.nextId, ...event };
    this.nextId += 1;
    for (const listener of this.listeners) {
      try {
        listener(published);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return published;
  }

  public subscribe(listener: WorkflowEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscriberCount(): number {
    return this.listeners.size;
  }
}

export async function registerWorkflowEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/workflow/events', async (request, reply) => {
    const session = await requireAuthenticatedSession(app, request, reply);
    if (session === undefined) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('event: ready\ndata: {"connected":true}\n\n');

    let pending = Promise.resolve();
    let pendingCount = 0;
    let sequence = 0;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    };
    const unsubscribe = app.sfudRuntime.workflowEvents.subscribe((event) => {
      if (closed || reply.raw.destroyed) return;
      // Bound pending authorization checks for slow clients; preserve event order.
      if (++pendingCount > 100) { finish(); return; }
      pending = pending.then(async () => {
        if (closed) return;
        if (!await isRequestSessionActive(app, request)) { finish(); return; }
        if (!await app.sfudRuntime.jobAccess.canAccess(event.resource, event.jobId, session.user.id)) return;
        if (closed || reply.raw.destroyed) return;
        const visible = { ...event, id: ++sequence };
        if (!reply.raw.write(`id: ${visible.id}\nevent: workflow\ndata: ${JSON.stringify(visible)}\n\n`)) finish();
      }).catch(finish).finally(() => { pendingCount -= 1; });
    });
    const heartbeat = setInterval(() => {
      void isRequestSessionActive(app, request).then((active) => {
        if (!active) finish();
        else if (!closed && !reply.raw.destroyed && !reply.raw.write(': heartbeat\n\n')) finish();
      }).catch(finish);
    }, 15_000);
    heartbeat.unref();
    request.raw.once('close', finish);
  });
}
