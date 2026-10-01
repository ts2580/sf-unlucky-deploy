import { describe, expect, it, vi } from 'vitest';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { applyMigrations } from '../src/storage/migrations.js';
import { DatabaseExecutor } from '../src/storage/database-executor.js';
import { GitRegistrationService } from '../src/git/git-registration-service.js';
import type { GitImportService } from '../src/git/git-import-service.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';

describe('기존 Git 주소 복구 migration', () => {
  it('소유자·provider·경로가 일치하는 연결로만 복구하고 불명확한 기록은 원격 접근 전에 차단한다', async () => {
    const database = await open({ filename: ':memory:', driver: sqlite3.Database });
    const now = () => '2026-09-22T00:00:00.000Z';
    try {
      await database.exec('PRAGMA foreign_keys = ON');
      await applyMigrations(database, now, 38);
      for (const owner of ['owner', 'other']) await database.run(`INSERT INTO users (id,email,display_name,role,created_at,updated_at) VALUES (?,?,?,'ADMIN',?,?)`, owner, `${owner}@example.test`, owner, now(), now());
      const cases = [
        { id: 'github', provider: 'github', host: 'github.example.test', url: 'https://github.example.test:8443/context/team/project.git', short: 'context/team/project', connectionOwner: 'owner', valid: true },
        { id: 'gitlab', provider: 'gitlab', host: 'gitlab.example.test', url: 'https://gitlab.example.test/team/sub/project.git', short: 'team/sub/project', connectionOwner: 'owner', valid: true },
        { id: 'bitbucket', provider: 'bitbucket', host: 'bitbucket.example.test', url: 'https://bitbucket.example.test:7990/bitbucket/scm/TEAM/project.git', short: 'bitbucket/scm/TEAM/project', connectionOwner: 'owner', valid: true },
        { id: 'wrong-owner', provider: 'gitlab', host: 'gitlab.example.test', url: 'https://gitlab.example.test/team/project.git', short: 'team/project', connectionOwner: 'other', valid: false },
        { id: 'wrong-path', provider: 'gitlab', host: 'gitlab.example.test', url: 'https://gitlab.example.test/team/project.git', short: 'other/project', connectionOwner: 'owner', valid: false },
        { id: 'wrong-provider', provider: 'github', host: 'gitlab.example.test', url: 'https://gitlab.example.test/team/project.git', short: 'team/project', connectionOwner: 'owner', valid: false },
        { id: 'cloud-account', provider: 'gitlab', host: 'gitlab.com', url: null, short: 'team/project', connectionOwner: 'owner', valid: true },
        { id: 'no-proof', provider: 'gitlab', host: 'gitlab.com', url: null, short: 'team/project', connectionOwner: null, valid: false },
      ];
      for (const entry of cases) {
        if (entry.connectionOwner) await database.run(`INSERT INTO git_connections (id,owner_user_id,provider,provider_host,provider_account_id,display_name,encrypted_access_token,granted_permissions_json,status,key_version,created_at,updated_at,repository_path,alias)
          VALUES (?,?,?, ?,?,?,'encrypted-fixture','[]','ACTIVE',1,?,?,?,'keep-alias')`, entry.id, entry.connectionOwner, entry.id === 'wrong-provider' ? 'gitlab' : entry.provider, entry.host, entry.id, entry.id, now(), now(), entry.url);
        const connection = entry.connectionOwner ? entry.id : null;
        const request = { provider: entry.provider, repositoryPath: entry.short, ...(connection ? { connectionId: connection } : {}), ref: { kind: 'branch', name: 'main' }, expectedCommitSha: 'a'.repeat(40) };
        await database.run(`INSERT INTO git_imports (id,owner_user_id,provider,connection_id,repository_path,ref_kind,ref_name,expected_commit_sha,status,created_at,updated_at)
          VALUES (?,'owner',?,?,?,'branch','main',?,'FAILED',?,?)`, entry.id, entry.provider, connection, entry.short, request.expectedCommitSha, now(), now());
        await database.run(`INSERT INTO git_registrations (id,owner_user_id,request_json,repository_id,status,created_at,alias) VALUES (?,'owner',?,?,'FAILED',?,'keep-branch')`, entry.id, JSON.stringify(request), `git:${entry.id}`, now());
      }
      await applyMigrations(database, now);
      const before = await database.all('SELECT * FROM git_imports');
      await applyMigrations(database, now);
      expect(await database.all('SELECT * FROM git_imports')).toEqual(before);
      for (const entry of cases) {
        const imported = await database.get('SELECT repository_path, repository_url_verified, safe_error_code FROM git_imports WHERE id = ?', entry.id);
        const registered = await database.get('SELECT request_json, repository_url_verified, error_message, alias FROM git_registrations WHERE id = ?', entry.id);
        expect(imported.repository_url_verified).toBe(Number(entry.valid));
        expect(registered.repository_url_verified).toBe(Number(entry.valid));
        expect(registered.alias).toBe('keep-branch');
        if (entry.valid) {
          expect(imported.repository_path).toBe(entry.url ?? entry.short);
          expect(JSON.parse(registered.request_json).repositoryPath).toBe(entry.url ?? entry.short);
        } else {
          expect(imported.repository_path).toBe(entry.short);
          expect(imported.safe_error_code).toBe('GIT_REPOSITORY_URL_REQUIRED');
          expect(registered.error_message).toContain('전체 HTTPS');
        }
      }
      expect(await database.all('SELECT DISTINCT encrypted_access_token, alias FROM git_connections')).toEqual([{ encrypted_access_token: 'encrypted-fixture', alias: 'keep-alias' }]);
      const executor = new DatabaseExecutor(database);
      const imports = { inspect: vi.fn(), warm: vi.fn(), prepareLatest: vi.fn() };
      const registrations = new GitRegistrationService(executor, imports as unknown as GitImportService);
      for (const id of ['wrong-owner', 'wrong-path', 'wrong-provider', 'no-proof']) {
        expect((await registrations.get(id, 'owner')).requiresRepositoryUrl).toBe(true);
        await expect(registrations.sync(id, 'owner')).rejects.toMatchObject({ code: 'GIT_REPOSITORY_URL_REQUIRED' });
        await expect(registrations.prepare(id, 'owner', 'ApexClass')).rejects.toMatchObject({ code: 'GIT_REPOSITORY_URL_REQUIRED' });
      }
      expect(imports.inspect).not.toHaveBeenCalled();
      expect(imports.warm).not.toHaveBeenCalled();
      expect((await registrations.sources('owner')).map((source) => source.id)).not.toContain('git-registered:no-proof');
      await new GitImportRepository(executor).recover();
      expect((await new GitImportRepository(executor).get('no-proof', 'owner')).errorCode).toBe('GIT_REPOSITORY_URL_REQUIRED');
      await registrations.close();
    } finally { await database.close(); }
  });
});
