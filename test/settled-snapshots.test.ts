import { expect, it } from 'vitest';
import { settledSnapshots } from '../src/commands/settled-snapshots.js';

it('첫 실패를 보존하되 형제 snapshot 완료까지 명령을 유지한다', async () => {
  const failure = new Error('conversion failed');
  let release!: (value: string) => void;
  const sibling = new Promise<string>((resolve) => { release = resolve; });
  let finished = false;
  const result = settledSnapshots([sibling, Promise.reject(failure)]);
  void result.catch(() => { finished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  release('retrieved');
  await expect(result).rejects.toBe(failure);
});

it('동시 실패시 첫 관측 오류와 성공시 snapshot 순서를 유지한다', async () => {
  const first = new Error('first');
  const later = new Error('later');
  let rejectSibling!: (reason: unknown) => void;
  const sibling = new Promise<string>((_resolve, reject) => { rejectSibling = reject; });
  const result = settledSnapshots([sibling, Promise.reject(first)]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  rejectSibling(later);
  await expect(result).rejects.toBe(first);
  await expect(settledSnapshots([Promise.resolve('left'), Promise.resolve('right')])).resolves.toEqual(['left', 'right']);
});
