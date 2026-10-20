import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWebServer } from '../src/web/server/app.js';
import type { SfClient } from '../src/salesforce/sf-client.js';
import { writeFixtureFiles } from './support/files.js';

describe('package request disconnect cancellation', () => {
  it.each(['inventory', 'retrieve'])('aborts %s, stops later Orgs, and permits a fresh successful load', async (stage) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-abort-'));
    let block = true;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const signals: AbortSignal[] = [];
    const retrieved: string[] = [];
    let cancelled = false;
    const client: SfClient = { async runJson(args, options) {
      if (args[0] === 'org') return { result: { nonScratchOrgs: ['dev', 'other'].map((alias) => ({ alias, connectedStatus: 'Connected', username: `${alias}@example.com` })) } };
      const inventory = args[0] === 'package';
      const alias = args[args.indexOf('--target-org') + 1]!;
      expect(options.signal).toBeDefined();
      signals.push(options.signal!);
      if (!inventory) retrieved.push(alias);
      if (block && (stage === 'inventory' ? inventory : !inventory)) {
        started();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => { cancelled = true; reject(options.signal!.reason); };
          options.signal!.addEventListener('abort', abort, { once: true });
          if (options.signal!.aborted) abort();
        });
      }
      if (inventory) return { result: [{ SubscriberPackageId: '033000000000001', SubscriberPackageVersionId: '04t000000000001', SubscriberPackageName: 'Unlocked', SubscriberPackageNamespace: null }] };
      await writeFixtureFiles(path.join(args[args.indexOf('--target-metadata-dir') + 1]!, 'Unlocked'), {
        'package.xml': `<Package><types><members>Owned_${alias}</members><name>ApexClass</name></types></Package>`,
      });
      return { result: { success: true } };
    } };
    const app = await createWebServer({ host: '127.0.0.1', port: 0, localMode: true, databasePath: path.join(root, 'db'), assetsDirectory: '/missing', sfClient: client });
    try {
      const auth = await app.inject('/api/v1/auth/status');
      const cookie = (auth.headers['set-cookie'] as string[]).map((item) => item.split(';')[0]).join('; ');
      const csrf = decodeURIComponent(cookie.split('; ').find((item) => item.startsWith('sfud_csrf='))!.slice('sfud_csrf='.length));
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const controller = new AbortController();
      const options = { method: 'POST', headers: { cookie, 'x-sfud-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ sourceIds: ['org:dev', 'org:other'] }) };
      const url = `${address}/api/v1/installed-packages/033000000000001/components`;
      const abandoned = fetch(url, { ...options, signal: controller.signal }).catch((error: unknown) => error);
      await waiting;
      controller.abort();
      await abandoned;
      await expect.poll(() => cancelled).toBe(true);
      expect(signals.at(-1)?.aborted).toBe(true);
      expect(retrieved).toEqual(stage === 'inventory' ? [] : ['dev']);
      block = false;
      const beforeRetry = signals.length;
      const response = await fetch(url, options);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ package: { componentCount: 2 }, components: [
        { type: 'ApexClass', fullName: 'Owned_dev' }, { type: 'ApexClass', fullName: 'Owned_other' },
      ] });
      expect(retrieved).toEqual(stage === 'inventory' ? ['dev', 'other'] : ['dev', 'dev', 'other']);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signals.slice(beforeRetry).every((signal) => !signal.aborted)).toBe(true);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  }, 10_000);
});
