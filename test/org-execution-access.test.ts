import { afterEach, describe, expect, it } from 'vitest';

import { normalizeSalesforceOrgId } from '../src/salesforce/org-identifier.js';
import { OrgExecutionAccessRepository } from '../src/storage/org-execution-access-repository.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

const stores: SqliteStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe('Salesforce Org ID별 실제 배포 권한', () => {
  it('같은 Org의 연결 별칭이 달라도 같은 정책을 적용하고 미설정 Org는 거부한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const access = new OrgExecutionAccessRepository(store.database, () => '2026-09-21T00:00:00.000Z');
    const admin = await users.create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
    const alice = await users.create({ email: 'alice@example.com', displayName: 'Alice', role: 'DEPLOYER' });
    const bob = await users.create({ email: 'bob@example.com', displayName: 'Bob', role: 'DEPLOYER' });
    const orgId = '00D000000000001';
    const canonicalId = normalizeSalesforceOrgId(orgId);

    await expect(access.assertCanExecute(orgId, alice.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await expect(access.assertCanExecute(orgId, admin.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await access.grant(orgId, admin.id, alice.id);
    await expect(access.assertCanExecute(canonicalId, alice.id)).resolves.toBeUndefined();
    await expect(access.assertCanExecute(orgId, bob.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await expect(access.assertCanExecute(orgId, admin.id)).resolves.toBeUndefined();
    expect(await access.list()).toEqual([{ orgId: canonicalId, userId: alice.id, grantedBy: admin.id,
      createdAt: '2026-09-21T00:00:00.000Z' }]);

    await access.revoke(canonicalId, admin.id, alice.id);
    expect(await access.listPolicies()).toEqual([{ orgId: canonicalId, enabledAt: '2026-09-21T00:00:00.000Z', grantCount: 0 }]);
    await expect(access.assertCanExecute(orgId, alice.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await store.database.run('UPDATE users SET disabled_at = ? WHERE id = ?', '2026-09-21T01:00:00.000Z', admin.id);
    await expect(access.assertCanExecute(orgId, admin.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  });

  it('레거시 별칭 권한을 새 Org ID 권한으로 자동 승격하지 않는다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const access = new OrgExecutionAccessRepository(store.database);
    const admin = await users.create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
    const deployer = await users.create({ email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER' });
    await store.database.run('INSERT INTO org_execution_policies (target_alias, enabled_by, enabled_at) VALUES (?, ?, ?)',
      'prod-primary', admin.id, new Date().toISOString());
    await store.database.run('INSERT INTO org_execution_grants (target_alias, user_id, granted_by, created_at) VALUES (?, ?, ?, ?)',
      'prod-primary', deployer.id, admin.id, new Date().toISOString());
    await expect(access.assertCanExecute('00D000000000001', deployer.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  });

  it('local 모드의 단일 운영자는 Org 정책 없이 실행할 수 있다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const admin = await users.create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
    const access = new OrgExecutionAccessRepository(store.database, undefined, true);
    await expect(access.assertCanExecute('00D000000000001', admin.id)).resolves.toBeUndefined();
  });
});
