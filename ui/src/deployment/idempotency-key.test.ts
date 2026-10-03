import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdempotencyKey } from './idempotency-key';

afterEach(() => vi.unstubAllGlobals());

describe('배포 요청 UUID', () => {
  it('사용 가능한 브라우저에서는 기본 randomUUID를 사용한다', () => {
    const id = '9ab355dc-acfc-41cd-9a48-86b4d86d429c';
    const randomUUID = vi.fn(() => id);
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', { randomUUID, getRandomValues });
    expect(createIdempotencyKey()).toBe(id);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('HTTP 대체 경로는 난수의 version·variant 비트만 UUID v4로 설정한다 (%i)', (byte, expected) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte));
    vi.stubGlobal('crypto', { getRandomValues });
    expect(createIdempotencyKey()).toBe(expected);
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0]![0]).toHaveLength(16);
  });

  it('보안 난수 생성 실패 시 취약한 대체 키를 발급하지 않는다', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('secure random unavailable'); } });
    expect(() => createIdempotencyKey()).toThrow('secure random unavailable');
  });
});
