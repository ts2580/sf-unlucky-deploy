import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistPending, listPending, completePending, settleRejectedPending } from './pending-submissions';
const store = new Map<string, string>();
function setup() {
  store.clear();
  vi.stubGlobal('localStorage', { get length() { return store.size; }, key: (index: number) => [...store.keys()][index] ?? null, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), setTimeout, clearTimeout });
}
const body = { sourceId: 'project:source', targetOrgId: 'org:target', scope: 'selected' as const, components: [{ type: 'ApexClass', fullName: 'Example' }] };
afterEach(() => vi.unstubAllGlobals());
describe('pending request preservation', () => {
  it('isolates owners and tabs, prevents mutation of an existing key and skips malformed records', () => {
    setup(); persistPending('owner', 'dry-run', 'first-key', body); persistPending('owner', 'dry-run', 'second-tab', body);
    persistPending('other', 'dry-run', 'first-key', body);
    expect(listPending('owner')).toHaveLength(2); expect(listPending('other')).toHaveLength(1);
    expect(() => persistPending('owner', 'dry-run', 'first-key', { ...body, targetOrgId: 'org:changed' })).toThrow('다른 설정');
    store.set('sfud:pending:v1:owner:broken', JSON.stringify({ owner: 'owner', key: 'broken', operation: 'dry-run', body, wireFingerprint: JSON.stringify(body), createdAt: 4 }));
    expect(listPending('owner')).toHaveLength(2);
    completePending('owner', 'first-key', 'confirmed-job'); expect(listPending('owner')).toHaveLength(1); expect(listPending('other')).toHaveLength(1);
  });
  it('refuses POST persistence when storage or schema fails and does not accumulate confirmed requests', () => {
    setup();
    for (let index = 0; index < 60; index++) { persistPending('owner', 'dry-run', `key-${index}`, body); completePending('owner', `key-${index}`, 'job'); }
    expect(listPending('owner')).toHaveLength(0);
    expect(() => persistPending('owner', 'dry-run', 'invalid', { ...body, testLevel: 'wrong' } as typeof body)).toThrow('입력');
    vi.stubGlobal('localStorage', { get length() { throw new Error('blocked'); } });
    expect(() => persistPending('owner', 'dry-run', 'blocked', body)).toThrow('blocked');
  });
  it('keeps transport ambiguity but clears definitive pre-admission rejection', async () => {
    setup(); persistPending('owner', 'dry-run', 'original', body);
    await settleRejectedPending('owner', 'original', { code: 'CLIENT_TIMEOUT', status: 0 }); expect(listPending('owner')).toHaveLength(1);
    await settleRejectedPending('owner', 'original', { code: 'FORBIDDEN', status: 403 }); expect(listPending('owner')).toHaveLength(1);
    await settleRejectedPending('owner', 'original', { code: 'FORBIDDEN', status: 403 }, true); expect(listPending('owner')).toHaveLength(0);
  });
});
