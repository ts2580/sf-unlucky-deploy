import { describe, expect, it } from 'vitest';

import { DeploymentAdmissionLimiter } from '../src/deploy/deployment-admission-limiter.js';

describe('배포 접수 준비 limiter', () => {
  it('사용자별과 전체 준비 슬롯을 분리하고 실패 후 정확히 반납한다', () => {
    const limiter = new DeploymentAdmissionLimiter(2, 3);
    const first = limiter.reserve('user-a');
    const second = limiter.reserve('user-a');
    const third = limiter.reserve('user-b');

    expect(() => limiter.reserve('user-a')).toThrow(/동시에 준비/u);
    expect(() => limiter.reserve('user-c')).toThrow(/서버의 배포 요청 준비/u);
    first.release();
    const afterFirstRelease = limiter.reserve('user-c');
    third.release();
    const afterFirstUserRelease = limiter.reserve('user-a');
    expect(() => limiter.reserve('user-a')).toThrow(/동시에 준비/u);
    second.release();
    afterFirstRelease.release();
    afterFirstUserRelease.release();
    expect(() => limiter.reserve('user-a')).not.toThrow();
  });
});
