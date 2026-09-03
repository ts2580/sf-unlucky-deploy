import { describe, expect, it } from 'vitest';

import {
  boundedCommandTimeoutMs,
  createDeadline,
  remainingDeadlineMs,
  salesforceWaitCommandTimeoutMs,
} from '../src/core/deadline.js';

describe('Salesforce command deadline', () => {
  it('60분 wait 명령에 60분보다 긴 process timeout을 배정한다', () => {
    expect(salesforceWaitCommandTimeoutMs(60)).toBe(61 * 60 * 1_000);
  });

  it('개별 명령 timeout을 전체 남은 시간으로 제한한다', () => {
    let now = 1_000;
    const deadline = createDeadline(20_000, () => now);
    now = 11_000;

    expect(remainingDeadlineMs(deadline)).toBe(10_000);
    expect(boundedCommandTimeoutMs(deadline, 5 * 60 * 1_000)).toBe(10_000);
  });
});
