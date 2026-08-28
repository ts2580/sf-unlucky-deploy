import type { FastifyInstance } from 'fastify';

import { requireAuthenticatedSession } from './auth-routes.js';

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

    const unsubscribe = app.sfudRuntime.workflowEvents.subscribe((event) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`id: ${event.id}\nevent: workflow\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();

    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
