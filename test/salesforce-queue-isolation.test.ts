import { expect, it } from 'vitest';

import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import { TokenVault } from '../src/git/token-vault.js';
import type { SfClient } from '../src/salesforce/sf-client.js';
import { runAsSalesforceUser } from '../src/salesforce/user-context.js';
import { UserSfClient } from '../src/salesforce/user-sf-client.js';
import { SalesforceConnectionRepository } from '../src/storage/salesforce-connection-repository.js';
import { openSqliteStore } from '../src/storage/sqlite-store.js';
import { UserRepository } from '../src/storage/user-repository.js';

it.each([1, 2])('큐 슬롯 %i개에서 같은 별칭을 쓴 대기 작업에 소유자의 인증만 복원한다', async (concurrency) => {
  const store = await openSqliteStore({ databasePath: ':memory:' });
  const queue = new SingleJobQueue(concurrency);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const users = new UserRepository(store.database);
    const ownerA = await users.create({ email: 'queue-a@example.test', displayName: 'A', role: 'DEPLOYER' });
    const ownerB = await users.create({ email: 'queue-b@example.test', displayName: 'B', role: 'DEPLOYER' });
    const repository = new SalesforceConnectionRepository(store.database,
      new TokenVault(new Map([[1, Buffer.alloc(32, 19)]]), 1));
    const urls = ['a', 'b'].map((value) => `force://PlatformCLI::${value.repeat(30)}@my.salesforce.com`);
    for (const [index, owner] of [ownerA, ownerB].entries()) {
      await repository.upsert(owner.id, 'shared', {
        orgId: `00D00000000000${index + 1}`, username: owner.email, instanceUrl: 'https://my.salesforce.com/',
      }, urls[index]!);
    }
    const tokensByHome = new Map<string, string>();
    const processClient: SfClient = {
      async runJson(args, options) {
        const home = options.environment!.HOME!;
        if (args[0] === 'org' && args[1] === 'login') {
          tokensByHome.set(home, options.stdin!.trim());
          return { status: 0, result: {} };
        }
        if (args[0] === 'org' && args[1] === 'auth') {
          return { status: 0, result: { sfdxAuthUrl: tokensByHome.get(home) } };
        }
        return { owner: tokensByHome.get(home) === urls[0] ? 'A' : 'B' };
      },
    };
    const client = new UserSfClient(repository, processClient);
    const execute = () => client.runJson(['org', 'display', '--target-org', 'shared'], { cwd: process.cwd() });
    let entered = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const first = Array.from({ length: concurrency }, (_, index) => runAsSalesforceUser(ownerA.id, () =>
      queue.enqueue(`a-${index}`, async () => {
        if (++entered === concurrency) signalStarted();
        await gate;
        return execute();
      })));
    await started;
    const second = runAsSalesforceUser(ownerB.id, () => queue.enqueue('b', execute));
    const anonymous = queue.enqueue('anonymous', execute);
    const anonymousAssertion = expect(anonymous).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    release();
    expect(await Promise.all(first)).toEqual(Array.from({ length: concurrency }, () => ({ owner: 'A' })));
    expect(await second).toEqual({ owner: 'B' });
    await anonymousAssertion;
    expect([...tokensByHome.values()].filter((value) => value === urls[0])).toHaveLength(concurrency);
    expect([...tokensByHome.values()].filter((value) => value === urls[1])).toHaveLength(1);
  } finally {
    release();
    await queue.onIdle();
    await store.close();
  }
});
