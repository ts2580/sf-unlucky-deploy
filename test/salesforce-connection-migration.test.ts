import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { expect, it } from 'vitest';

import { TokenVault } from '../src/git/token-vault.js';
import { DatabaseExecutor } from '../src/storage/database-executor.js';
import { applyMigrations } from '../src/storage/migrations.js';
import { SalesforceConnectionRepository } from '../src/storage/salesforce-connection-repository.js';

it('v45 연결의 ID와 암호문을 보존해 세대 이전 후에도 복호화하고 재등록을 구분한다', async () => {
  const raw = await open({ filename: ':memory:', driver: sqlite3.Database });
  const database = new DatabaseExecutor(raw);
  const now = () => '2026-09-30T00:00:00.000Z';
  const owner = 'legacy-fixture-owner';
  const id = 'legacy-fixture-connection';
  const authUrl = 'force://PlatformCLI::legacy-fixture-refresh-token@my.salesforce.com';
  const vault = new TokenVault(new Map([[1, Buffer.alloc(32, 13)]]), 1);
  const encrypted = vault.encrypt(authUrl, {
    ownerUserId: owner, resourceId: id, provider: 'salesforce', host: 'salesforce', purpose: 'sfdx-auth-url',
  });
  try {
    await raw.exec('PRAGMA foreign_keys = ON');
    await applyMigrations(raw, now, 45);
    await raw.run(`INSERT INTO users (id, email, display_name, role, created_at, updated_at)
      VALUES (?, 'legacy@example.test', 'Legacy fixture', 'DEPLOYER', ?, ?)`, owner, now(), now());
    await raw.run(`INSERT INTO salesforce_connections (id, owner_user_id, alias, org_id, username,
      instance_url, encrypted_auth_url, status, created_at, updated_at)
      VALUES (?, ?, 'legacy', '00D000000000001', 'legacy@example.test',
        'https://my.salesforce.com/', ?, 'CONNECTED', ?, ?)`, id, owner, encrypted, now(), now());

    await applyMigrations(raw, now);
    await applyMigrations(raw, now);
    expect(await raw.get('SELECT id, generation, encrypted_auth_url FROM salesforce_connections WHERE id = ?', id))
      .toEqual({ id, generation: 1, encrypted_auth_url: encrypted });
    const repository = new SalesforceConnectionRepository(database, vault);
    expect(await repository.authUrl(owner, id, 1)).toBe(authUrl);
    await expect(repository.authUrl('different-owner', id, 1)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    const replacement = await repository.upsert(owner, 'legacy', {
      orgId: '00D000000000002', username: 'replacement@example.test', instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    expect(replacement).toMatchObject({ id, generation: 2, createdAt: now() });
    await expect(repository.authUrl(owner, id, 1)).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    expect(await repository.authUrl(owner, id, 2)).toBe(authUrl);
  } finally {
    await database.close();
  }
});
