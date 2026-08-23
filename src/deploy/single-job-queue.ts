export interface JobQueueStatus {
  activeJobId?: string;
  queuedCount: number;
}

export class SingleJobQueue {
  private tail: Promise<void> = Promise.resolve();
  private activeJobId: string | undefined;
  private readonly pendingJobIds = new Set<string>();

  public enqueue<T>(jobId: string, task: () => Promise<T>): Promise<T> {
    if (this.pendingJobIds.has(jobId) || this.activeJobId === jobId) {
      return Promise.reject(new Error(`이미 대기 중이거나 실행 중인 작업입니다: ${jobId}`));
    }
    this.pendingJobIds.add(jobId);

    const result = this.tail.then(async () => {
      this.pendingJobIds.delete(jobId);
      this.activeJobId = jobId;
      try {
        return await task();
      } finally {
        this.activeJobId = undefined;
      }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public status(): JobQueueStatus {
    return {
      ...(this.activeJobId === undefined ? {} : { activeJobId: this.activeJobId }),
      queuedCount: this.pendingJobIds.size,
    };
  }

  public async onIdle(): Promise<void> {
    await this.tail;
  }
}
