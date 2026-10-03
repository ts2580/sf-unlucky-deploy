import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { applyMigrations } from '../src/storage/migrations.js';
import { UserRepository } from '../src/storage/user-repository.js';
import { DeploymentPresetRepository, type SavedDeploymentSelection } from '../src/storage/deployment-preset-repository.js';
import { DeploymentDraftRepository } from '../src/storage/deployment-draft-repository.js';

const selection: SavedDeploymentSelection = {
  options: { compareCurrentType: true, showIdentical: false, excludedPackageIds: [], testLevel: 'auto', tests: [] },
  source: { kind: 'project', id: 'project:fixture' },
  target: { kind: 'org', identity: { alias: 'target', username: 'target@example.com', orgId: '00D000000000001' } },
};
async function fixture() {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  const users = new UserRepository(store.database);
  const owner = await users.create({ email: 'owner@example.com', displayName: 'owner', role: 'ADMIN' });
  const other = await users.create({ email: 'other@example.com', displayName: 'other', role: 'ADMIN' });
  return { store, owner: owner.id, other: other.id };
}
describe('배포 저장 설정과 탭 초안 저장 경계', () => {
  it('동시 저장으로 preset 50개 한도를 넘지 않고 다른 사용자 quota·수정·삭제를 격리한다', async () => {
    const f = await fixture(); const repository = new DeploymentPresetRepository(f.store.database);
    try {
      for (let index = 0; index < 49; index++) await repository.save(f.owner, `설정 ${index}`, selection);
      const pending = await Promise.allSettled([1, 2, 3].map((index) => repository.save(f.owner, `동시 ${index}`, selection)));
      expect(pending.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(pending.filter((result) => result.status === 'rejected')).toHaveLength(2);
      const ownerPresets = await repository.list(f.owner); expect(ownerPresets).toHaveLength(50);
      const own = ownerPresets[0]!;
      await expect(repository.get(f.other, own.id)).rejects.toThrow('찾을 수');
      await expect(repository.save(f.other, '타인 수정', selection, own.id)).rejects.toThrow('찾을 수');
      await expect(repository.remove(f.other, own.id)).rejects.toThrow('찾을 수');
      expect((await repository.save(f.owner, '내 설정 수정', selection, own.id)).name).toBe('내 설정 수정');
      await repository.save(f.other, '다른 사용자 독립 quota', selection);
      expect(await repository.list(f.other)).toHaveLength(1);
      expect((await repository.get(f.owner, own.id)).settings).toEqual(selection);
    } finally { await f.store.close(); }
  });
  it('동시 탭 생성은 20개 한도를 지키고 역순 응답이 같은 탭의 최신 선택을 덮지 않는다', async () => {
    const f = await fixture(); const repository = new DeploymentDraftRepository(f.store.database);
    try {
      for (let index = 0; index < 19; index++) await repository.save(f.owner, `tab-${index}`, selection);
      const attempts = await Promise.allSettled(['a', 'b', 'c'].map((tab) => repository.save(f.owner, tab, selection)));
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await repository.list(f.owner)).toHaveLength(20);
      const prior = await repository.reserveRevision(); const latest = await repository.reserveRevision();
      const changed: SavedDeploymentSelection = { ...selection, options: { ...selection.options, showIdentical: true } };
      const newer = await repository.save(f.owner, 'tab-0', changed, latest);
      await expect(repository.save(f.owner, 'tab-0', selection, prior)).rejects.toThrow('최근 요청');
      await expect(repository.save(f.owner, 'tab-0', selection, latest)).rejects.toThrow('최근 요청');
      expect((await repository.get(f.owner, newer.id)).settings).toEqual(changed);
      const other = await repository.save(f.other, 'tab-0', selection);
      await expect(repository.get(f.other, newer.id)).rejects.toThrow('만료');
      await expect(repository.remove(f.other, newer.id)).rejects.toThrow('찾을 수');
      expect((await repository.get(f.owner, newer.id)).settings).toEqual(changed);
      expect(other.id).not.toBe(newer.id);
    } finally { await f.store.close(); }
  });
  it('TTL의 정확한 만료 시점에는 초안을 숨기고 만료 삭제 후 같은 사용자 quota를 다시 사용할 수 있다', async () => {
    const f = await fixture(); let now = '2026-10-04T00:00:00.000Z';
    const repository = new DeploymentDraftRepository(f.store.database, () => now);
    try {
      const drafts = [];
      for (let index = 0; index < 20; index++) drafts.push(await repository.save(f.owner, `tab-${index}`, selection));
      now = '2026-10-04T23:59:59.999Z'; expect(await repository.list(f.owner)).toHaveLength(20);
      now = '2026-10-05T00:00:00.000Z'; expect(await repository.list(f.owner)).toEqual([]);
      await expect(repository.get(f.owner, drafts[0]!.id)).rejects.toThrow('만료');
      const replacement = await repository.save(f.owner, 'fresh-tab', selection);
      expect(await repository.list(f.owner)).toHaveLength(1);
      expect((await repository.get(f.owner, replacement.id)).settings).toEqual(selection);
      expect((await f.store.database.get<{ count: number }>('SELECT COUNT(*) count FROM deployment_drafts WHERE owner_user_id = ?', f.owner))?.count).toBe(1);
    } finally { await f.store.close(); }
  });
  it('기존 v46 DB를 업그레이드해도 사용자·인증 digest·사용자 설정을 보존하고 재개방에도 유지한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-settings-upgrade-')); const filename = path.join(root, 'state.db');
    const legacy = await open({ filename, driver: sqlite3.Database });
    try {
      await legacy.exec('PRAGMA foreign_keys=ON'); await applyMigrations(legacy, () => '2026-10-03T00:00:00.000Z', 46);
      await legacy.run("INSERT INTO users(id,email,display_name,role,created_at,updated_at) VALUES('owner','old@example.com','기존 사용자','ADMIN','old','old')");
      await legacy.run("INSERT INTO password_credentials(user_id,password_digest,updated_at) VALUES('owner','synthetic-existing-digest','old')");
      await legacy.run("INSERT INTO user_settings(user_id,test_class_suffix,updated_at) VALUES('owner','_Existing','old')");
      const before = { user: await legacy.get('SELECT * FROM users'), auth: await legacy.get('SELECT * FROM password_credentials'), settings: await legacy.get('SELECT * FROM user_settings') };
      await legacy.close();
      let store = await openSqliteStore({ databasePath: filename });
      try {
        expect(await store.database.get('SELECT * FROM users')).toEqual(before.user);
        expect(await store.database.get('SELECT * FROM password_credentials')).toEqual(before.auth);
        expect(await store.database.get('SELECT * FROM user_settings')).toEqual(before.settings);
        const preset = await new DeploymentPresetRepository(store.database).save('owner', '업그레이드 후 설정', selection);
        const draft = await new DeploymentDraftRepository(store.database).save('owner', 'upgrade-tab', selection);
        await store.close(); store = await openSqliteStore({ databasePath: filename });
        expect((await new DeploymentPresetRepository(store.database).get('owner', preset.id)).settings).toEqual(selection);
        expect((await new DeploymentDraftRepository(store.database).get('owner', draft.id)).settings).toEqual(selection);
        expect(await store.database.get('SELECT * FROM password_credentials')).toEqual(before.auth);
      } finally { await store.close(); }
    } finally { await legacy.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
});
