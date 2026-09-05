export interface Deadline {
  expiresAt: number;
  now: () => number;
}

export function createDeadline(timeoutMs: number, now: () => number = Date.now): Deadline {
  return { expiresAt: now() + timeoutMs, now };
}

export function remainingDeadlineMs(deadline: Deadline): number {
  return Math.max(0, deadline.expiresAt - deadline.now());
}

export function boundedCommandTimeoutMs(deadline: Deadline, maximumMs: number): number {
  return Math.max(1, Math.min(maximumMs, remainingDeadlineMs(deadline)));
}

export function salesforceWaitCommandTimeoutMs(waitMinutes: number): number {
  return (waitMinutes + 1) * 60 * 1_000;
}
