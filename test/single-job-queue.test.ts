import { describe, expect, it } from 'vitest';

import { SingleJobQueue } from '../src/deploy/single-job-queue.js';

describe('단일 배포 작업 큐', () => {
  it('여러 작업이 동시에 실행되지 않도록 직렬화한다', async () => {
    const queue = new SingleJobQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue('job-1', async () => {
      events.push('job-1:start');
      await firstGate;
      events.push('job-1:end');
    });
    const second = queue.enqueue('job-2', async () => {
      events.push('job-2:start');
      events.push('job-2:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['job-1:start']);
    expect(queue.status()).toEqual({ activeJobId: 'job-1', queuedCount: 1, accepting: true });
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['job-1:start', 'job-1:end', 'job-2:start', 'job-2:end']);
    expect(queue.status()).toEqual({ queuedCount: 0, accepting: true });
  });

  it('앞 작업이 실패해도 다음 작업을 실행하고 중복 ID를 거부한다', async () => {
    const queue = new SingleJobQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue('job-1', async () => {
      await gate;
      throw new Error('expected failure');
    });

    await expect(queue.enqueue('job-1', async () => undefined)).rejects.toThrow(/이미 대기/u);
    const second = queue.enqueue('job-2', async () => 'completed');
    release();
    await expect(first).rejects.toThrow('expected failure');
    await expect(second).resolves.toBe('completed');
    await queue.onIdle();
  });

  it('종료 시 새 작업을 거부하고 active 작업에 abort를 전달한다', async () => {
    const queue = new SingleJobQueue();
    const aborted = new Promise<void>((resolve) => {
      void queue.enqueue('job-1', async (signal) => {
        await new Promise<void>((_settle, reject) => {
          signal.addEventListener('abort', () => {
            resolve();
            reject(new Error('aborted'));
          }, { once: true });
        });
      }).catch(() => undefined);
    });
    await Promise.resolve();
    queue.stopAccepting();
    await expect(queue.enqueue('job-2', async () => undefined)).rejects.toThrow(/종료 중/u);
    expect(await queue.waitForIdle(1)).toBe(false);
    queue.abort();
    await aborted;
    expect(await queue.waitForIdle(100)).toBe(true);
    expect(queue.status()).toEqual({ queuedCount: 0, accepting: false });
  });
});
