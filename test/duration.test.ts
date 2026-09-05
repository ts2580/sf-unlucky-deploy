import { describe, expect, it } from 'vitest';

import { formatDuration } from '../ui/src/duration.js';

describe('소요시간 표시', () => {
  it.each([
    [0, '0초'],
    [8, '8초'],
    [59, '59초'],
    [60, '1분'],
    [68, '1분 8초'],
    [3_599, '59분 59초'],
    [3_600, '1시간'],
    [3_728, '1시간 2분 8초'],
  ])('%i초를 %s로 표시한다', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
