import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const KEY_LENGTH = 64;
const LEGACY_COST = 16_384;
const TARGET_COST = 32_768;
const MAX_COST = TARGET_COST;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
const SALT_ENCODED_LENGTH = 22;
const KEY_ENCODED_LENGTH = 86;
export const MAX_PASSWORD_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, TARGET_COST, BLOCK_SIZE, PARALLELIZATION);
  return ['scrypt', TARGET_COST, BLOCK_SIZE, PARALLELIZATION, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const parameters = parsePasswordDigest(digest);
  if (parameters === undefined) return false;
  try {
    const actual = await derive(password, parameters.salt, parameters.cost, BLOCK_SIZE, PARALLELIZATION);
    return timingSafeEqual(actual, parameters.expected);
  } catch {
    return false;
  }
}

/** A valid legacy digest is retained only long enough to replace it after login. */
export function passwordNeedsRehash(digest: string): boolean {
  const parameters = parsePasswordDigest(digest);
  return parameters !== undefined && parameters.cost !== TARGET_COST;
}

function assertPassword(password: string): void {
  if (password.length < 12 || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('비밀번호는 12자 이상 128자 이하여야 합니다.');
  }
}

async function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_MEMORY,
    }, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

interface PasswordDigestParameters {
  cost: number;
  salt: Buffer;
  expected: Buffer;
}

function parsePasswordDigest(digest: string): PasswordDigestParameters | undefined {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelization)
    || cost < LEGACY_COST || cost > MAX_COST || blockSize !== BLOCK_SIZE || parallelization !== PARALLELIZATION) {
    return undefined;
  }
  if (parts[1] !== String(cost) || parts[2] !== String(blockSize) || parts[3] !== String(parallelization)
    || parts[4]!.length !== SALT_ENCODED_LENGTH || parts[5]!.length !== KEY_ENCODED_LENGTH) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length !== 16 || expected.length !== KEY_LENGTH
    || salt.toString('base64url') !== parts[4] || expected.toString('base64url') !== parts[5]) return undefined;
  return { cost, salt, expected };
}
