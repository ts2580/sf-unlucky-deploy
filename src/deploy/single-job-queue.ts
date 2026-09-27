export interface JobQueueStatus {
  activeJobId?: string;
  queuedCount: number;
  accepting: boolean;
}

class JobQueueClosedError extends Error {
  public constructor() {
    super('서버가 종료 중이어서 새 작업을 받을 수 없습니다.');
    this.name = 'JobQueueClosedError';
  }
}

export class JobQueueCapacityError extends Error {
  public constructor() {
    super('대기 중인 작업 수가 서버 수용량에 도달했습니다.');
    this.name = 'JobQueueCapacityError';
  }
}

export class JobQueueReservation {
  private state: 'RESERVED' | 'CONSUMED' | 'RELEASED' = 'RESERVED';

  public constructor(private readonly releaseSlot: () => void) {}

  public consume(): boolean {
    if (this.state !== 'RESERVED') return false;
    this.state = 'CONSUMED';
    this.releaseSlot();
    return true;
  }

  public release(): void {
    if (this.state !== 'RESERVED') return;
    this.state = 'RELEASED';
    this.releaseSlot();
  }
}

// Deployment keeps the default of one. Comparison explicitly opts into a
// bounded number of independent jobs; shutdown drains or aborts every lane.
export class SingleJobQueue {
  private readonly running = new Map<string, AbortController>();
  private readonly pending: { id: string; run(signal: AbortSignal): Promise<void> }[] = [];
  private readonly completions = new Set<Promise<unknown>>();
  private reservedCount = 0;
  private accepting = true;
  private abortRequested = false;

  public constructor(
    private readonly concurrency = 1,
    private readonly maximumQueued = 20,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('작업 동시 실행 수가 올바르지 않습니다.');
    if (!Number.isSafeInteger(maximumQueued) || maximumQueued < 1) throw new Error('작업 대기 수가 올바르지 않습니다.');
  }

  public reserve(): JobQueueReservation {
    this.assertAccepting();
    if (this.pending.length + this.reservedCount >= this.maximumQueued) throw new JobQueueCapacityError();
    this.reservedCount += 1;
    return new JobQueueReservation(() => { this.reservedCount -= 1; });
  }

  public enqueue<T>(
    jobId: string,
    task: (signal: AbortSignal) => Promise<T>,
    reservation?: JobQueueReservation,
  ): Promise<T> {
    if (!this.accepting) {
      reservation?.release();
      return Promise.reject(new JobQueueClosedError());
    }
    if (reservation !== undefined && !reservation.consume()) {
      return Promise.reject(new Error('유효하지 않은 작업 대기 예약입니다.'));
    }
    if (reservation === undefined && this.pending.length + this.reservedCount >= this.maximumQueued) {
      return Promise.reject(new JobQueueCapacityError());
    }
    if (this.running.has(jobId) || this.pending.some((entry) => entry.id === jobId)) {
      return Promise.reject(new Error(`이미 대기 중이거나 실행 중인 작업입니다: ${jobId}`));
    }
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ id: jobId, run: async (signal) => {
        try { resolve(await task(signal)); } catch (error) { reject(error); }
      } });
    });
    this.completions.add(result);
    void result.then(() => this.completions.delete(result), () => this.completions.delete(result));
    queueMicrotask(() => this.drain());
    return result;
  }

  private drain(): void {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      const controller = new AbortController();
      if (this.abortRequested) controller.abort();
      this.running.set(entry.id, controller);
      void entry.run(controller.signal).finally(() => { this.running.delete(entry.id); this.drain(); });
    }
  }

  public status(): JobQueueStatus {
    const activeJobId = this.running.keys().next().value as string | undefined;
    return { ...(activeJobId === undefined ? {} : { activeJobId }), queuedCount: this.pending.length, accepting: this.accepting };
  }
  public async onIdle(): Promise<void> {
    while (this.completions.size > 0) await Promise.allSettled([...this.completions]);
    // Let lane cleanup finish before callers close storage.
    await Promise.resolve();
  }
  public assertAccepting(): void { if (!this.accepting) throw new JobQueueClosedError(); }
  public stopAccepting(): void { this.accepting = false; }
  public abort(): void {
    this.abortRequested = true;
    for (const controller of this.running.values()) controller.abort();
  }
  public async waitForIdle(timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.onIdle().then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}
