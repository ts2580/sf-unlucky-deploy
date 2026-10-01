import { afterEach, describe, expect, it } from 'vitest';

import { TokenVault } from '../src/git/token-vault.js';
import { UserSfClient } from '../src/salesforce/user-sf-client.js';
import { currentSalesforceConnectionPin, currentSalesforceUserId, pinSalesforceConnection, runAsSalesforceUser } from '../src/salesforce/user-context.js';
import { SfCommandFailedError, type SfClient, type SfRunOptions } from '../src/salesforce/sf-client.js';
import { SalesforceConnectionRepository } from '../src/storage/salesforce-connection-repository.js';
import { openSqliteStore, type SqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';
import { createWebServer } from '../src/web/server/app.js';
import { requireAuthenticatedSession } from '../src/web/server/auth-routes.js';
import { WorkspaceService } from '../src/web/server/workspace-service.js';

const stores: SqliteStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

const authUrl = 'force://PlatformCLI::aaaaaaaaaaaaaaaaaaaaaaaaaaaa@my.salesforce.com';
const rotatedUrl = 'force://PlatformCLI::bbbbbbbbbbbbbbbbbbbbbbbbbbbb@my.salesforce.com';

class FakeSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];
  private readonly aliasesByHome = new Map<string, string[]>();
  public beforeRun: ((args: readonly string[], options: SfRunOptions) => Promise<void>) | undefined = undefined;
  public orgListResult: unknown | undefined;
  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    await this.beforeRun?.(args, options);
    if (args[0] === 'org' && args[1] === 'list' && this.orgListResult !== undefined) return this.orgListResult;
    const home = options.environment?.HOME ?? '';
    if (args[0] === 'org' && args[1] === 'login') {
      const alias = args[args.indexOf('--alias') + 1]!;
      this.aliasesByHome.set(home, [...(this.aliasesByHome.get(home) ?? []), alias]);
      return { status: 0, result: {} };
    }
    if (args[0] === 'org' && args[1] === 'auth') return { status: 0, result: { sfdxAuthUrl: rotatedUrl } };
    if (args[0] === 'org' && args[1] === 'display') return { status: 0, result: {
      id: '00D000000000001', username: 'alice@example.com', instanceUrl: 'https://my.salesforce.com/',
    } };
    if (args[0] === 'org' && args[1] === 'list') return { status: 0, result: {
      nonScratchOrgs: (this.aliasesByHome.get(home) ?? []).map((alias) => ({ alias,
        username: `${alias}@example.com`, orgId: '00D000000000001', instanceUrl: 'https://my.salesforce.com/',
        connectedStatus: 'Connected',
      })),
    } };
    return { status: 0, result: { nonScratchOrgs: [] } };
  }
}

describe('사용자별 Salesforce CLI 인증 격리', () => {
  it('일시 실패 뒤 재시도하며 확정 invalid_grant만 재인증 상태로 바꾼다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-status@example.com', displayName: 'SF Status', role: 'DEPLOYER',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 5)]]), 1));
    const connection = await repository.upsert(user.id, 'status-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const client = new UserSfClient(repository, processClient);
    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'login') {
        processClient.beforeRun = undefined;
        throw new Error('temporary connection timeout');
      }
    };
    const firstResult = await runAsSalesforceUser(user.id, () => client.runJson(['org', 'list'], { cwd: process.cwd() }));
    expect(firstResult).toMatchObject({ result: { nonScratchOrgs: [] } });
    expect(await repository.get(user.id, connection.id)).toMatchObject({ status: 'CONNECTED' });
    const retryResult = await runAsSalesforceUser(user.id, () => client.runJson(['org', 'list'], { cwd: process.cwd() }));
    expect(retryResult).toMatchObject({ result: { nonScratchOrgs: [expect.objectContaining({ alias: 'status-org' })] } });
    expect(processClient.calls.filter((call) => call.args[0] === 'org' && call.args[1] === 'login')).toHaveLength(2);
    expect(processClient.calls.filter((call) => call.args[0] === 'org' && call.args[1] === 'list')).toHaveLength(1);
    expect(await repository.get(user.id, connection.id)).toMatchObject({ status: 'CONNECTED' });

    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'login') {
        processClient.beforeRun = undefined;
        throw new SfCommandFailedError('invalid_grant: [REDACTED]', undefined, undefined, 'invalid_grant');
      }
    };
    await runAsSalesforceUser(user.id, () => client.runJson(['org', 'list'], { cwd: process.cwd() }));
    expect(await repository.get(user.id, connection.id)).toMatchObject({ status: 'REAUTH_REQUIRED' });
  });

  it('인증 복원 중 같은 별칭이 재등록되면 제출을 막고 지연 export가 새 token을 덮지 않는다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-race@example.com', displayName: 'SF Race', role: 'DEPLOYER',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 6)]]), 1));
    const original = await repository.upsert(user.id, 'race-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const client = new UserSfClient(repository, processClient);
    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'login') {
        processClient.beforeRun = undefined;
        await repository.upsert(user.id, 'race-org', {
          orgId: '00D000000000002', username: 'replacement@example.com', instanceUrl: 'https://my.salesforce.com/',
        }, rotatedUrl);
      }
    };
    await expect(runAsSalesforceUser(user.id, () => client.runJson(
      ['org', 'display', '--target-org', 'race-org'], { cwd: process.cwd() })))
      .rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    expect(processClient.calls.some((call) => call.args[1] === 'display')).toBe(false);
    const replacement = (await repository.getByAlias(user.id, 'race-org'))!;
    expect(replacement.generation).toBe(original.generation + 1);
    expect(await repository.authUrl(user.id, replacement.id, replacement.generation)).toBe(rotatedUrl);

    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'auth') {
        processClient.beforeRun = undefined;
        await repository.upsert(user.id, 'race-org', {
          orgId: '00D000000000003', username: 'later@example.com', instanceUrl: 'https://my.salesforce.com/',
        }, authUrl);
      }
    };
    await runAsSalesforceUser(user.id, () => client.runJson(
      ['org', 'display', '--target-org', 'race-org'], { cwd: process.cwd() }));
    const latest = (await repository.getByAlias(user.id, 'race-org'))!;
    expect(await repository.authUrl(user.id, latest.id, latest.generation)).toBe(authUrl);
  });

  it('요청에서 기존 세대를 pin한 뒤 auth read 전에 재등록되면 새 세대를 선택하지 않는다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-before-read@example.com', displayName: 'SF Before Read', role: 'DEPLOYER',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 10)]]), 1));
    const original = await repository.upsert(user.id, 'pre-read-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const client = new UserSfClient(repository, processClient);
    await expect(runAsSalesforceUser(user.id, async () => {
      pinSalesforceConnection('pre-read-org', original.id, original.generation);
      await repository.upsert(user.id, 'pre-read-org', {
        orgId: '00D000000000002', username: 'changed@example.com', instanceUrl: 'https://my.salesforce.com/',
      }, rotatedUrl);
      return await client.runJson(['org', 'display', '--target-org', 'pre-read-org'], { cwd: process.cwd() });
    })).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    expect(processClient.calls).toEqual([]);
  });

  it('재등록 후 늦게 도착한 invalid_grant도 새 연결을 재인증 상태로 바꾸지 않는다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-late-failure@example.com', displayName: 'SF Late Failure', role: 'DEPLOYER',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 11)]]), 1));
    const original = await repository.upsert(user.id, 'late-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const client = new UserSfClient(repository, processClient);
    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'login') {
        processClient.beforeRun = undefined;
        await repository.upsert(user.id, 'late-org', {
          orgId: '00D000000000002', username: 'current@example.com', instanceUrl: 'https://my.salesforce.com/',
        }, rotatedUrl);
        throw new SfCommandFailedError('invalid_grant: [REDACTED]', undefined, undefined, 'invalid_grant');
      }
    };
    await expect(runAsSalesforceUser(user.id, () => client.runJson(['org', 'list'], { cwd: process.cwd() })))
      .rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    const current = (await repository.getByAlias(user.id, 'late-org'))!;
    expect(current).toMatchObject({ generation: original.generation + 1, status: 'CONNECTED' });
    expect(await repository.authUrl(user.id, current.id, current.generation)).toBe(rotatedUrl);
  });

  it('동시 최초 등록과 재등록을 직렬화하고 세대 CAS가 이전 작업을 막는다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const alice = await users.create({ email: 'alice-race@example.com', displayName: 'Alice', role: 'DEPLOYER' });
    const vault = new TokenVault(new Map([[1, Buffer.alloc(32, 9)]]), 1);
    const repository = new SalesforceConnectionRepository(store.database, vault);
    const registrations = Array.from({ length: 16 }, (_, index) => ({
      identity: { orgId: `00D0000000000${String(index + 1).padStart(2, '0')}`,
        username: `alice-${index}@example.com`, instanceUrl: 'https://my.salesforce.com/' },
      authUrl: `force://PlatformCLI::${String(index).padStart(28, 'a')}@my.salesforce.com`,
    }));
    const saved = await Promise.all(registrations.map(({ identity, authUrl: url }) =>
      repository.upsert(alice.id, 'race-org', identity, url)));
    expect(saved).toHaveLength(16);
    expect(new Set(saved.map((connection) => connection.id)).size).toBe(1);
    const final = (await repository.getByAlias(alice.id, 'race-org'))!;
    expect(final.generation).toBe(16);
    const decrypted = await repository.authUrl(alice.id, final.id, final.generation);
    const winner = registrations.find(({ identity }) => identity.username === final.username);
    expect(winner?.authUrl).toBe(decrypted);

    const replacement = await repository.upsert(alice.id, 'race-org', {
      orgId: '00D000000000099', username: 'replacement@example.com', instanceUrl: 'https://my.salesforce.com/',
    }, registrations[0]!.authUrl);
    await expect(repository.authUrl(alice.id, final.id, final.generation)).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    expect(await repository.rotateAuthUrl(alice.id, final.id, final.generation, registrations[1]!.authUrl)).toBe(false);
    expect(await repository.markReauthRequired(alice.id, final.id, final.generation)).toBe(false);
    expect(await repository.getByAlias(alice.id, 'race-org')).toMatchObject({ id: replacement.id, generation: 17, status: 'CONNECTED' });
    expect(await repository.authUrl(alice.id, replacement.id, replacement.generation)).toBe(registrations[0]!.authUrl);
  });

  it('다른 사용자 연결을 가져오지 않고, 사용자별 임시 HOME과 암호화 URL을 사용한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const alice = await users.create({ email: 'alice@example.com', displayName: 'Alice', role: 'DEPLOYER' });
    const bob = await users.create({ email: 'bob@example.com', displayName: 'Bob', role: 'DEPLOYER' });
    const vault = new TokenVault(new Map([[1, Buffer.alloc(32, 7)]]), 1);
    const repository = new SalesforceConnectionRepository(store.database, vault);
    const aliceConnection = await repository.upsert(alice.id, 'alice-org', {
      orgId: '00D000000000001', username: 'alice@example.com', instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    await repository.upsert(bob.id, 'bob-org', {
      orgId: '00D000000000002', username: 'bob@example.com', instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const stored = await store.database.get<{ encrypted_auth_url: string }>(
      'SELECT encrypted_auth_url FROM salesforce_connections WHERE id = ?', aliceConnection.id);
    expect(stored?.encrypted_auth_url).not.toContain(authUrl);
    expect(await repository.list(alice.id)).toEqual([expect.objectContaining({ alias: 'alice-org' })]);
    expect(await repository.get(bob.id, aliceConnection.id)).toBeUndefined();

    const processClient = new FakeSfClient();
    const isolated = new UserSfClient(repository, processClient);
    await runAsSalesforceUser(alice.id, async () => isolated.runJson(['org', 'list'], { cwd: process.cwd() }));
    const imported = processClient.calls.filter((call) => call.args[0] === 'org' && call.args[1] === 'login');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.args).toContain('alice-org');
    expect(imported[0]?.options.stdin).toContain(authUrl);
    expect(imported[0]?.options.environment?.HOME).not.toBe(process.env.HOME);
    expect(imported[0]?.options.environment?.SFUD_SF_TOKEN_SECRET).toBeUndefined();
    expect(await repository.authUrl(alice.id, aliceConnection.id, aliceConnection.generation)).toBe(rotatedUrl);

    await runAsSalesforceUser(alice.id, async () => {
      await isolated.runJson(['org', 'list'], { cwd: process.cwd() });
      await repository.remove(alice.id, aliceConnection.id);
      await repository.upsert(alice.id, 'alice-org', {
        orgId: '00D000000000001', username: 'alice@example.com', instanceUrl: 'https://my.salesforce.com/',
      }, authUrl);
      await expect(isolated.runJson(['org', 'list', 'metadata-types', '--target-org', 'alice-org'],
        { cwd: process.cwd() })).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
    });

    await expect(runAsSalesforceUser(bob.id, async () =>
      isolated.runJson(['org', 'list', 'metadata-types', '--target-org', 'alice-org'], { cwd: process.cwd() })))
      .rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(await repository.remove(bob.id, aliceConnection.id)).toBe(false);
    expect((await repository.list(alice.id)).map((connection) => connection.alias)).toEqual(['alice-org']);
  });

  it('HTTP 세션의 사용자 컨텍스트와 Salesforce 연결 API를 두 사용자 사이에 격리한다', async () => {
    const previousSecret = process.env.SFUD_SF_TOKEN_SECRET;
    process.env.SFUD_SF_TOKEN_SECRET = 'c'.repeat(64);
    let server: Awaited<ReturnType<typeof createWebServer>> | undefined;
    try {
      server = await createWebServer({ host: '127.0.0.1', port: 27_546, assetsDirectory: '/missing',
        databasePath: ':memory:', bootstrapToken: 'bootstrap-test-token', sfClient: new FakeSfClient() });
      const app = server;
      app.get('/test-salesforce-context', async (request, reply) => {
        const session = await requireAuthenticatedSession(app, request, reply);
        if (session === undefined) return;
        return { userId: currentSalesforceUserId() };
      });
      const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/auth/bootstrap',
        payload: { bootstrapToken: 'bootstrap-test-token', email: 'alice@example.com',
          displayName: 'Alice', password: 'alice correct horse battery staple' } });
      const aliceSession = bootstrap.json<{ user: { id: string }; csrfToken: string }>();
      const aliceCookie = (bootstrap.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');
      const bob = await app.sfudRuntime.auth.createManagedUser({ actorUserId: aliceSession.user.id,
        email: 'bob@example.com', displayName: 'Bob', role: 'DEPLOYER', password: 'bob correct horse battery staple' });
      const bobSession = await app.sfudRuntime.auth.login('bob@example.com', 'bob correct horse battery staple');
      const bobCookie = `sfud_session=${encodeURIComponent(bobSession.sessionToken)}; sfud_csrf=${encodeURIComponent(bobSession.csrfToken)}`;
      const aliceHeaders = { host: '127.0.0.1:27546', cookie: aliceCookie, 'x-sfud-csrf': aliceSession.csrfToken };
      const bobHeaders = { host: '127.0.0.1:27546', cookie: bobCookie, 'x-sfud-csrf': bobSession.csrfToken };
      expect((await app.inject({ url: '/test-salesforce-context', headers: aliceHeaders })).json()).toEqual({ userId: aliceSession.user.id });
      expect((await app.inject({ url: '/test-salesforce-context', headers: bobHeaders })).json()).toEqual({ userId: bob.id });
      const registered = await app.inject({ method: 'POST', url: '/api/v1/salesforce/connections',
        headers: aliceHeaders, payload: { alias: 'alice-org', sfdxAuthUrl: authUrl } });
      expect(registered.statusCode).toBe(201);
      const connectionId = registered.json<{ connection: { id: string } }>().connection.id;
      expect((await app.inject({ url: '/api/v1/salesforce/connections', headers: bobHeaders })).json())
        .toMatchObject({ connections: [] });
      expect((await app.inject({ url: `/api/v1/salesforce/connections/${connectionId}`, headers: bobHeaders })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/salesforce/connections/${connectionId}`, headers: bobHeaders })).statusCode).toBe(404);
      expect((await app.inject({ url: `/api/v1/salesforce/connections/${connectionId}`, headers: aliceHeaders })).statusCode).toBe(200);
    } finally {
      if (server !== undefined) await server.close();
      if (previousSecret === undefined) delete process.env.SFUD_SF_TOKEN_SECRET;
      else process.env.SFUD_SF_TOKEN_SECRET = previousSecret;
    }
  });

  it('Org 소스 목록과 identity 캐시도 사용자별로 나누고 연결 ID를 작업 identity에 고정한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const users = new UserRepository(store.database);
    const alice = await users.create({ email: 'alice2@example.com', displayName: 'Alice', role: 'OPERATOR' });
    const bob = await users.create({ email: 'bob2@example.com', displayName: 'Bob', role: 'OPERATOR' });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 9)]]), 1));
    const identity = { orgId: '00D000000000001', username: 'same@example.com', instanceUrl: 'https://my.salesforce.com/' };
    const aliceConnection = await repository.upsert(alice.id, 'alice-source', identity, authUrl);
    await repository.upsert(bob.id, 'bob-source', identity, authUrl);
    const workspace = await WorkspaceService.create(new UserSfClient(repository, new FakeSfClient()),
      process.cwd(), [], {}, repository);
    try {
      expect((await runAsSalesforceUser(alice.id, () => workspace.listOrgs())).map((org) => org.alias)).toEqual(['alice-source']);
      expect((await runAsSalesforceUser(bob.id, () => workspace.listOrgs())).map((org) => org.alias)).toEqual(['bob-source']);
      expect(await runAsSalesforceUser(alice.id, () => workspace.getOrgIdentity('alice-source')))
        .toMatchObject({ connectionId: aliceConnection.id, connectionGeneration: aliceConnection.generation });
      const replacement = await repository.upsert(alice.id, 'alice-source', identity, rotatedUrl);
      workspace.clearOrgCache(alice.id);
      expect(await runAsSalesforceUser(alice.id, () => workspace.getOrgIdentity('alice-source')))
        .toMatchObject({ connectionId: replacement.id, connectionGeneration: replacement.generation });
      await expect(runAsSalesforceUser(bob.id, () => workspace.resolveSource('org:alice-source', bob.id)))
        .rejects.toThrow(/연결된 Salesforce org/u);
    } finally { await workspace.close(); }
  });

  it('공유 Org pending Promise를 기다린 각 요청 컨텍스트에 개별 connection pin을 복사한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-shared@example.com', displayName: 'SF Shared', role: 'OPERATOR',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 8)]]), 1));
    const connection = await repository.upsert(user.id, 'shared-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const entered = deferred<void>();
    const gate = deferred<void>();
    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'list') {
        processClient.beforeRun = undefined;
        entered.resolve();
        await gate.promise;
      }
    };
    const workspace = await WorkspaceService.create(new UserSfClient(repository, processClient),
      process.cwd(), [], {}, repository);
    try {
      const first = runAsSalesforceUser(user.id, async () => {
        await workspace.listOrgs();
        return currentSalesforceConnectionPin('shared-org');
      });
      await entered.promise;
      const second = runAsSalesforceUser(user.id, async () => {
        await workspace.listOrgs();
        return currentSalesforceConnectionPin('shared-org');
      });
      gate.resolve();
      expect(await Promise.all([first, second])).toEqual([
        { id: connection.id, generation: connection.generation },
        { id: connection.id, generation: connection.generation },
      ]);
    } finally { await workspace.close(); }
  });

  it('clearOrgCache가 오래된 pending 조회를 끊어 새 generation 결과만 캐시한다', async () => {
    const store = await openSqliteStore({ databasePath: ':memory:' });
    stores.push(store);
    const user = await new UserRepository(store.database).create({
      email: 'sf-cache-race@example.com', displayName: 'SF Cache Race', role: 'OPERATOR',
    });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 12)]]), 1));
    await repository.upsert(user.id, 'cache-org', {
      orgId: '00D000000000001', username: user.email, instanceUrl: 'https://my.salesforce.com/',
    }, authUrl);
    const processClient = new FakeSfClient();
    const firstListStarted = deferred<void>();
    const releaseFirstList = deferred<void>();
    let orgListCalls = 0;
    processClient.beforeRun = async (args) => {
      if (args[0] === 'org' && args[1] === 'list') {
        orgListCalls += 1;
        if (orgListCalls === 1) {
          firstListStarted.resolve();
          await releaseFirstList.promise;
        } else {
          processClient.orgListResult = { status: 0, result: { nonScratchOrgs: [{ alias: 'cache-org',
            username: 'cache-new@example.com', orgId: '00D000000000002',
            instanceUrl: 'https://my.salesforce.com/', connectedStatus: 'Connected' }] } };
        }
      }
    };
    const workspace = await WorkspaceService.create(new UserSfClient(repository, processClient),
      process.cwd(), [], {}, repository);
    try {
      const staleRequest = runAsSalesforceUser(user.id, () => workspace.listOrgs());
      await firstListStarted.promise;
      const replacement = await repository.upsert(user.id, 'cache-org', {
        orgId: '00D000000000002', username: 'cache-new@example.com', instanceUrl: 'https://my.salesforce.com/',
      }, rotatedUrl);
      workspace.clearOrgCache(user.id);
      const fresh = await runAsSalesforceUser(user.id, () => workspace.getOrgIdentity('cache-org'));
      expect(fresh).toMatchObject({ connectionId: replacement.id, connectionGeneration: replacement.generation,
        username: 'cache-new@example.com' });
      releaseFirstList.resolve();
      await expect(staleRequest).rejects.toMatchObject({ code: 'ORG_IDENTITY_CHANGED' });
      const cached = await runAsSalesforceUser(user.id, () => workspace.getOrgIdentity('cache-org'));
      expect(cached).toMatchObject({ connectionGeneration: replacement.generation, username: 'cache-new@example.com' });
      expect(orgListCalls).toBe(2);
    } finally {
      releaseFirstList.resolve();
      await workspace.close();
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value) => resolve(value as T) };
}
