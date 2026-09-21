import { afterEach, describe, expect, it } from 'vitest';

import { SfudError } from '../src/core/errors.js';
import { OrgExecutionAccessRepository } from '../src/storage/org-execution-access-repository.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

const stores: SqliteStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => store.close()));
});

describe('대상 org 실제 배포 allowlist', () => {
  it('명시 활성화 전에는 기존 권한을 유지하고, 활성화 후에는 ADMIN 또는 부여된 활성 사용자만 허용한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const access = new OrgExecutionAccessRepository(store.database, () => '2026-09-21T00:00:00.000Z');
    const admin = await users.create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
    const deployer = await users.create({ email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER' });
    const other = await users.create({ email: 'other@example.com', displayName: 'Other', role: 'DEPLOYER' });

    await expect(access.assertCanExecute('production', deployer.id)).resolves.toBeUndefined();
    await access.grant('production', admin.id, deployer.id);
    await expect(access.assertCanExecute('production', deployer.id)).resolves.toBeUndefined();
    await expect(access.assertCanExecute('production', other.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await expect(access.assertCanExecute('production', admin.id)).resolves.toBeUndefined();
    expect(await access.list()).toEqual([{
      targetAlias: 'production', userId: deployer.id, grantedBy: admin.id, createdAt: '2026-09-21T00:00:00.000Z',
    }]);

    await access.revoke('production', admin.id, deployer.id);
    await expect(access.assertCanExecute('production', deployer.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    await store.database.run('UPDATE users SET disabled_at = ? WHERE id = ?', '2026-09-21T01:00:00.000Z', admin.id);
    await expect(access.assertCanExecute('production', admin.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(await store.database.all<Array<{ event_type: string }>>(
      "SELECT event_type FROM audit_events WHERE entity_type = 'SALESFORCE_ORG' ORDER BY id",
    )).toEqual([{ event_type: 'ORG_EXECUTION_ACCESS_CHANGED' }, { event_type: 'ORG_EXECUTION_ACCESS_CHANGED' }]);
  });

  it('ADMIN만 allowlist를 변경하고 별칭과 사용자를 검증한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const access = new OrgExecutionAccessRepository(store.database);
    const admin = await users.create({ email: 'admin@example.com', displayName: 'Admin', role: 'ADMIN' });
    const deployer = await users.create({ email: 'deployer@example.com', displayName: 'Deployer', role: 'DEPLOYER' });

    await expect(access.grant('production', deployer.id, admin.id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' } satisfies Partial<SfudError>);
    await expect(access.grant('../production', admin.id, deployer.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' } satisfies Partial<SfudError>);
    await expect(access.grant('production', admin.id, 'missing-user')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' } satisfies Partial<SfudError>);
  });
});
