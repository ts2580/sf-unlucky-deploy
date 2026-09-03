export interface JobQueueStatus {
  activeJobId?: string;
  queuedCount: number;
  accepting: boolean;
}

export class JobQueueClosedError extends Error {
  public constructor() {
    super('서버가 종료 중이어서 새 작업을 받을 수 없습니다.');
    this.name = 'JobQueueClosedError';
  }
}

export class SingleJobQueue {
  private tail: Promise<void> = Promise.resolve();
  private activeJobId: string | undefined;
  private activeController: AbortController | undefined;
  private readonly pendingJobIds = new Set<string>();
  private accepting = true;
  private abortRequested = false;

  public enqueue<T>(jobId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new JobQueueClosedError());
    if (this.pendingJobIds.has(jobId) || this.activeJobId === jobId) {
      return Promise.reject(new Error(`이미 대기 중이거나 실행 중인 작업입니다: ${jobId}`));
    }
    this.pendingJobIds.add(jobId);

    const result = this.tail.then(async () => {
      this.pendingJobIds.delete(jobId);
      this.activeJobId = jobId;
      const controller = new AbortController();
      this.activeController = controller;
      if (this.abortRequested) controller.abort();
      try {
        return await task(controller.signal);
      } finally {
        this.activeJobId = undefined;
        this.activeController = undefined;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public status(): JobQueueStatus {
    return {
      ...(this.activeJobId === undefined ? {} : { activeJobId: this.activeJobId }),
      queuedCount: this.pendingJobIds.size,
      accepting: this.accepting,
    };
  }

  public async onIdle(): Promise<void> {
    await this.tail;
  }

  public assertAccepting(): void {
    if (!this.accepting) throw new JobQueueClosedError();
  }

  public stopAccepting(): void {
    this.accepting = false;
  }

  public abort(): void {
    this.abortRequested = true;
    this.activeController?.abort();
  }

  public async waitForIdle(timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.onIdle().then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
