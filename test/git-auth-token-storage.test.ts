import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenVault, type TokenContext } from '../src/git/token-vault.js';
import { GitConnectionRepository } from '../src/storage/git-connection-repository.js';
import { applyMigrations } from '../src/storage/migrations.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

const stores: SqliteStore[] = [];
const roots: string[] = [];
const now = '2026-09-20T00:00:00.000Z';
const aad: TokenContext = { ownerUserId: 'owner-a', resourceId: 'connection-a', provider: 'github', host: 'github.com', purpose: 'access-token' };

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-token-storage-'));
  roots.push(root);
  const key = randomBytes(32);
  const store = await openSqliteStore({ databasePath: path.join(root, 'data/sfud.db'), now: () => now });
  stores.push(store);
  const users = new UserRepository(store.database);
  const owner = await users.create({ email: 'owner@example.com', displayName: 'owner', role: 'ADMIN' });
  const other = await users.create({ email: 'other@example.com', displayName: 'other', role: 'ADMIN' });
  const vault = new TokenVault(new Map([[1, key]]), 1);
  const repository = new GitConnectionRepository(store.database, vault);
  return { root, store, owner, other, vault, key, repository };
}

describe('Git PAT/API token 암호화 저장과 migration 23', { timeout: 30_000 }, () => {
  it('GCM random IV, AAD, 암호문 변조와 key rotation을 검증한다', () => {
    const key1 = randomBytes(32), key2 = randomBytes(32);
    const old = new TokenVault(new Map([[1, key1]]), 1);
    const encoded = old.encrypt('private-token', aad);
    expect(old.encrypt('private-token', aad)).not.toBe(encoded);
    expect(old.decrypt(encoded, aad)).toBe('private-token');
    for (const changed of [
      { ownerUserId: 'owner-b' }, { resourceId: 'connection-b' }, { provider: 'gitlab' as const },
      { host: 'gitlab.com' }, { purpose: 'api-username' as const },
    ]) expect(() => old.decrypt(encoded, { ...aad, ...changed })).toThrow();
    const envelope = JSON.parse(encoded) as Record<string, unknown>;
    expect(() => old.decrypt(JSON.stringify({ ...envelope, tag: Buffer.alloc(16).toString('base64url') }), aad)).toThrow();
    const rotated = new TokenVault(new Map([[1, key1], [2, key2]]), 2);
    expect(rotated.decrypt(encoded, aad)).toBe('private-token');
    expect(JSON.parse(rotated.encrypt('new-token', aad)).keyVersion).toBe(2);
    expect(() => new TokenVault(new Map([[2, key2]]), 2).decrypt(encoded, aad)).toThrow();
  });

  it('키 파일은 32-byte mode 0600만 허용한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-token-key-')); roots.push(root);
    await expect(TokenVault.fromKeyFile(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    const file = path.join(root, 'key');
    await writeFile(file, randomBytes(32), { mode: 0o600 });
    const vault = await TokenVault.fromKeyFile(file);
    expect(vault.decrypt(vault.encrypt('roundtrip', aad), aad)).toBe('roundtrip');
    await writeFile(file, 'too-short');
    await expect(TokenVault.fromKeyFile(file)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('환경변수 secret은 JS 문자 수·양 끝 공백·제어문자와 32-byte salt를 엄격히 검증한다', async () => {
    const salt = randomBytes(32);
    const valid = 's'.repeat(32);
    const vault = await TokenVault.fromSecret(valid, salt);
    const encoded = vault.encrypt('secret-derived-token', aad);
    expect(vault.decrypt(encoded, aad)).toBe('secret-derived-token');
    await expect(TokenVault.fromSecret('s'.repeat(31), salt)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret('s'.repeat(1025), salt)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret(` ${valid}`, salt)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret(`${valid} `, salt)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret(`${valid}\u0000`, salt)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret(valid, Buffer.alloc(31))).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(TokenVault.fromSecret(valid, Buffer.alloc(33))).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    const otherSaltVault = await TokenVault.fromSecret(valid, randomBytes(32));
    expect(() => otherSaltVault.decrypt(encoded, aad)).toThrow();
    const otherSecretVault = await TokenVault.fromSecret('t'.repeat(32), salt);
    expect(() => otherSecretVault.decrypt(encoded, aad)).toThrow();
    await expect(TokenVault.fromSecret(valid, salt, 0)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('secret-derived vault는 migration 24의 salt로 재시작해도 복호화하고 DB/WAL에 평문을 남기지 않는다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-token-secret-')); roots.push(root);
    const databasePath = path.join(root, 'data/sfud.db');
    const secret = 'persistent-secret-value-'.repeat(2);
    const store = await openSqliteStore({ databasePath, now: () => now }); stores.push(store);
    const salt = randomBytes(32);
    await store.database.run('INSERT INTO git_token_key_parameters (id, salt) VALUES (1, ?)', salt.toString('base64url'));
    const vault = await TokenVault.fromSecret(secret, salt);
    const users = new UserRepository(store.database);
    const owner = await users.create({ email: 'secret-owner@example.com', displayName: 'owner', role: 'ADMIN' });
    const repository = new GitConnectionRepository(store.database, vault);
    const token = 'secret-derived-persistent-token';
    const connection = await repository.save({ ownerUserId: owner.id, provider: 'github', providerHost: 'github.com',
      providerAccountId: 'secret-account', displayName: 'Secret account', grantedPermissions: ['read'], tokens: { accessToken: token } });
    const raw = await store.database.get<{ encrypted_access_token: string }>(
      'SELECT encrypted_access_token FROM git_connections WHERE id = ?', connection.id);
    expect(raw?.encrypted_access_token).toBeDefined();
    expect(raw?.encrypted_access_token).not.toContain(token);
    expect(raw?.encrypted_access_token).not.toContain(secret);
    for (const suffix of ['', '-wal']) {
      const bytes = await readOptional(`${databasePath}${suffix}`);
      if (bytes !== undefined) {
        expect(bytes.includes(Buffer.from(token))).toBe(false);
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
      }
    }
    await store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = await openSqliteStore({ databasePath, now: () => now }); stores.push(reopened);
    const persisted = await reopened.database.get<{ salt: string }>('SELECT salt FROM git_token_key_parameters WHERE id = 1');
    expect(persisted?.salt).toBe(salt.toString('base64url'));
    const restartedVault = await TokenVault.fromSecret(secret, Buffer.from(persisted!.salt, 'base64url'));
    await expect(new GitConnectionRepository(reopened.database, restartedVault).readCredentials(owner.id, connection.id))
      .resolves.toMatchObject({ tokens: { accessToken: token } });
  });

  it.each([
    ['github', 'github.com', undefined], ['gitlab', 'gitlab.com', undefined], ['bitbucket', 'bitbucket.org', 'user@example.com'],
  ] as const)('%s PAT/API username을 암호화하고 owner 외에는 읽지 못한다', async (provider, host, apiUsername) => {
    const f = await fixture();
    const accessToken = `${provider}-access-token-secret`;
    const connection = await f.repository.save({
      ownerUserId: f.owner.id, provider, providerHost: host, providerAccountId: `${provider}-account`, displayName: `${provider} account`,
      grantedPermissions: ['read'], tokens: { accessToken, ...(apiUsername === undefined ? {} : { apiUsername }), expiresAt: '2026-09-21T00:00:00.000Z' },
    });
    expect(JSON.stringify(connection)).not.toContain('secret');
    expect(await f.repository.list(f.other.id)).toEqual([]);
    await expect(f.repository.readCredentials(f.other.id, connection.id)).rejects.toMatchObject({ code: 'GIT_CONNECTION_REQUIRED' });
    await expect(f.repository.readCredentials(f.owner.id, connection.id)).resolves.toMatchObject({
      tokens: { accessToken, ...(apiUsername === undefined ? {} : { apiUsername }), expiresAt: '2026-09-21T00:00:00.000Z' },
    });
    const raw = await f.store.database.get<{ encrypted_access_token: string; encrypted_api_username: string | null; encrypted_refresh_token: string | null; credential_type: string }>(
      'SELECT encrypted_access_token, encrypted_api_username, encrypted_refresh_token, credential_type FROM git_connections WHERE id = ?', connection.id,
    );
    expect(raw).toMatchObject({ credential_type: 'token', encrypted_refresh_token: null });
    expect(raw?.encrypted_access_token).not.toContain(accessToken);
    if (apiUsername !== undefined) expect(raw?.encrypted_api_username).not.toContain(apiUsername);
    for (const suffix of ['', '-wal']) {
      const bytes = await readOptional(`${f.store.databasePath}${suffix}`);
      if (bytes !== undefined) expect(bytes.includes(Buffer.from(accessToken))).toBe(false);
    }
    const id = connection.id;
    await f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const reopened = await openSqliteStore({ databasePath: f.store.databasePath, now: () => now }); stores.push(reopened);
    expect((await new GitConnectionRepository(reopened.database, new TokenVault(new Map([[1, f.key]]), 1))
      .readCredentials(f.owner.id, id)).tokens.accessToken).toBe(accessToken);
  });

  it('migration 23은 기존 OAuth credential을 REAUTH_REQUIRED로 무효화하고 OAuth 거래를 삭제한다', async () => {
    const database = await open({ filename: ':memory:', driver: sqlite3.Database });
    try {
      await database.exec('PRAGMA foreign_keys = ON');
      await applyMigrations(database, () => now, 22);
      await database.run("INSERT INTO users (id, email, display_name, role, created_at, updated_at) VALUES ('legacy-user', 'legacy@example.com', 'Legacy', 'ADMIN', ?, ?)", now, now);
      await database.run("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('legacy-session', 'legacy-user', 'legacy-hash', ?, ?)", '2026-09-21T00:00:00.000Z', now);
      await database.run(`INSERT INTO git_connections
        (id, owner_user_id, provider, provider_host, provider_account_id, display_name, encrypted_access_token, encrypted_refresh_token,
         expires_at, granted_permissions_json, status, key_version, token_version, created_at, updated_at)
        VALUES ('legacy-connection', 'legacy-user', 'github', 'github.com', 'legacy-account', 'Legacy', 'encrypted-access', 'encrypted-refresh', ?, '[]', 'ACTIVE', 1, 3, ?, ?)`,
      '2026-09-21T00:00:00.000Z', now, now);
      await database.run(`INSERT INTO git_oauth_transactions
        (id, state_hash, owner_user_id, initiating_session_id, browser_binding_hash, provider, callback_uri, fixed_return_path, expires_at, status, created_at)
        VALUES ('legacy-transaction', 'state-hash', 'legacy-user', 'legacy-session', 'browser-hash', 'github', 'https://deploy.test/callback', '/settings', ?, 'STARTED', ?)`, '2026-09-21T00:00:00.000Z', now);
      await applyMigrations(database, () => now, 23);
      expect(await database.get('SELECT credential_type, encrypted_access_token, encrypted_refresh_token, status, token_version FROM git_connections WHERE id = ?', 'legacy-connection'))
        .toEqual({ credential_type: 'oauth', encrypted_access_token: null, encrypted_refresh_token: null, status: 'REAUTH_REQUIRED', token_version: 4 });
      expect(await database.get('SELECT COUNT(*) count FROM git_oauth_transactions')).toEqual({ count: 0 });
    } finally { await database.close(); }
  });
});

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
