import { SfudError } from '../core/errors.js';

/** Limits work performed before a deployment job can be persisted and queued. */
export class DeploymentAdmissionLimiter {
  private active = 0;
  private readonly activeByUser = new Map<string, number>();

  public constructor(
    private readonly maximumPerUser = 2,
    private readonly maximumTotal = 8,
  ) {
    if (!Number.isSafeInteger(maximumPerUser) || maximumPerUser < 1) throw new Error('사용자별 접수 준비 한도가 올바르지 않습니다.');
    if (!Number.isSafeInteger(maximumTotal) || maximumTotal < 1) throw new Error('전체 접수 준비 한도가 올바르지 않습니다.');
  }

  public reserve(userId: string): DeploymentAdmissionReservation {
    const userActive = this.activeByUser.get(userId) ?? 0;
    if (userActive >= this.maximumPerUser) {
      throw new SfudError('REQUEST_USER_LIMIT', '동시에 준비할 수 있는 배포 요청 수를 초과했습니다. 잠시 후 다시 시도하세요.');
    }
    if (this.active >= this.maximumTotal) {
      throw new SfudError('REQUEST_CAPACITY_EXCEEDED', '서버의 배포 요청 준비 수용량을 초과했습니다. 잠시 후 다시 시도하세요.');
    }
    this.active += 1;
    this.activeByUser.set(userId, userActive + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        const current = this.activeByUser.get(userId) ?? 0;
        if (current <= 1) this.activeByUser.delete(userId);
        else this.activeByUser.set(userId, current - 1);
      },
    };
  }
}

export interface DeploymentAdmissionReservation {
  release(): void;
}
