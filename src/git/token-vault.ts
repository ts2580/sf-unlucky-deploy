import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { open } from 'node:fs/promises';
import { GitError } from './git-errors.js';
import type { GitProviderId } from './git-repository.js';

export interface TokenContext {
  ownerUserId: string;
  resourceId: string;
  provider: GitProviderId;
  host: string;
  purpose: 'access-token' | 'refresh-token' | 'api-username';
}
interface Envelope { keyVersion: number; iv: string; tag: string; ciphertext: string }

export class TokenVault {
  private readonly keys: ReadonlyMap<number, Buffer>;
  public constructor(keys: ReadonlyMap<number, Buffer>, public readonly currentKeyVersion: number) {
    if (!Number.isSafeInteger(currentKeyVersion) || currentKeyVersion < 1 || !keys.has(currentKeyVersion)
      || [...keys].some(([version, key]) => !Number.isSafeInteger(version) || version < 1 || key.length !== 32)) {
      throw new GitError('PROVIDER_NOT_CONFIGURED');
    }
    this.keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
  }

  public static async fromSecret(secret: string, salt: Buffer, version = 1): Promise<TokenVault> {
    if (secret.length < 32 || secret.length > 1024 || secret !== secret.trim()
      || /[\u0000-\u001f\u007f]/u.test(secret) || salt.length !== 32) {
      throw new GitError('PROVIDER_NOT_CONFIGURED');
    }
    try {
      const key = await new Promise<Buffer>((resolve, reject) => {
        scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
          (error, derived) => error === null ? resolve(derived) : reject(error));
      });
      try { return new TokenVault(new Map([[version, key]]), version); }
      finally { key.fill(0); }
    } catch { throw new GitError('PROVIDER_NOT_CONFIGURED'); }
  }

  public static async fromKeyFile(file: string, version = 1): Promise<TokenVault> {
    try {
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size !== 32 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
          throw new GitError('PROVIDER_NOT_CONFIGURED');
        }
        const key = await handle.readFile();
        try { return new TokenVault(new Map([[version, key]]), version); }
        finally { key.fill(0); }
      } finally { await handle.close(); }
    } catch { throw new GitError('PROVIDER_NOT_CONFIGURED'); }
  }

  public encrypt(plaintext: string, context: TokenContext): string {
    if (Buffer.byteLength(plaintext) === 0 || Buffer.byteLength(plaintext) > 64 * 1024) throw new GitError('GIT_REAUTH_REQUIRED');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentKeyVersion)!, iv);
    cipher.setAAD(aad(context, this.currentKeyVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({ keyVersion: this.currentKeyVersion, iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') } satisfies Envelope);
  }

  public decrypt(encoded: string, context: TokenContext): string {
    try {
      if (encoded.length > 100_000) throw new Error();
      const envelope: unknown = JSON.parse(encoded);
      if (typeof envelope !== 'object' || envelope === null || !('keyVersion' in envelope)) throw new Error();
      const value = envelope as Envelope;
      const key = this.keys.get(value.keyVersion);
      if (key === undefined) throw new Error();
      const iv = decode(value.iv, 12);
      const tag = decode(value.tag, 16);
      const ciphertext = decode(value.ciphertext);
      if (ciphertext.length === 0 || ciphertext.length > 64 * 1024) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(aad(context, value.keyVersion));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch { throw new GitError('GIT_REAUTH_REQUIRED'); }
  }
}

function aad(context: TokenContext, keyVersion: number): Buffer {
  return Buffer.from(JSON.stringify(['sfud-git-v1', keyVersion, context.ownerUserId, context.resourceId, context.provider, context.host, context.purpose]));
}
function decode(value: string, expectedLength?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) throw new Error();
  return bytes;
}
