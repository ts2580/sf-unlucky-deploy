import { describe, expect, it } from 'vitest';

import { hashPassword, passwordNeedsRehash, verifyPassword } from '../src/auth/password.js';

const legacyDigest = 'scrypt$16384$8$1$YWJjZGVmZ2hpamtsbW5vcA$71iq-9jmTvOEflLj7tfwS8RopMa4tmw2Hhh6HZBH8KCscMWlT6IsqzXQQFQzkqlvR1ANIbXanWQC5sgQo6yyLw';

describe('비밀번호 digest migration', () => {
  it('새 digest는 target 비용을 사용하고 기존 digest는 검증만 허용한다', async () => {
    const target = await hashPassword('correct horse battery staple');
    expect(target).toMatch(/^scrypt\$32768\$8\$1\$/u);
    await expect(verifyPassword('correct horse battery staple', target)).resolves.toBe(true);
    await expect(verifyPassword('legacy account password', legacyDigest)).resolves.toBe(true);
    expect(passwordNeedsRehash(target)).toBe(false);
    expect(passwordNeedsRehash(legacyDigest)).toBe(true);
  });

  it('지원 범위 밖 비용과 비정상 digest를 KDF 전에 거부한다', async () => {
    const unsupported = legacyDigest.replace('scrypt$16384$', 'scrypt$65536$');
    await expect(verifyPassword('legacy account password', unsupported)).resolves.toBe(false);
    expect(passwordNeedsRehash(unsupported)).toBe(false);
    await expect(verifyPassword('legacy account password', 'scrypt$32768$8$1$short$short')).resolves.toBe(false);
    const malformedBase64 = legacyDigest.replace('YWJjZGVmZ2hpamtsbW5vcA', '!!!!!!!!!!!!!!!!!!!!!!');
    await expect(verifyPassword('legacy account password', malformedBase64)).resolves.toBe(false);
    const oversizedSalt = legacyDigest.replace('YWJjZGVmZ2hpamtsbW5vcA', 'a'.repeat(2_000));
    await expect(verifyPassword('legacy account password', oversizedSalt)).resolves.toBe(false);
  });
});
