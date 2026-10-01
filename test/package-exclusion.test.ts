import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareSnapshots } from '../src/metadata/comparator.js';
import { belongsToPackage, resolvePackageExclusion, listInstalledPackages, validateExcludedPackageIds } from '../src/metadata/package-exclusion.js';
import type { MetadataSnapshot } from '../src/sources/snapshot.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('installed package exclusion', () => {
  const directories: string[] = [];
  afterEach(async () => removeDirectoriesAfterTest(directories));

  it('unions installed namespaces across orgs, deduplicates aliases and reports packages without namespaces', async () => {
    const calls: string[][] = [];
    const result = await resolvePackageExclusion([
      { kind: 'org', alias: 'left', displayName: 'left' },
      { kind: 'org', alias: 'right', displayName: 'right' },
      { kind: 'org', alias: 'left', displayName: 'left' },
    ], { runJson: async (args) => {
      calls.push([...args]);
      return { result: [
        { SubscriberPackageId: args.at(-1) === 'left' ? '033000000000001' : '033000000000002', SubscriberPackageName: 'Installed', SubscriberPackageNamespace: args.at(-1) === 'left' ? 'pkg' : 'other' },
        { SubscriberPackageId: '033000000000003', SubscriberPackageName: 'Unlocked', SubscriberPackageNamespace: null },
      ] };
    } }, process.cwd());
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ namespaces: ['other', 'pkg'], unnamespacedPackages: ['Unlocked'] });
  });

  it('selects one package by ID and rejects unknown, unnamespaced and shared-namespace packages', async () => {
    const sources = [{ kind: 'org' as const, alias: 'left', displayName: 'left' },
      { kind: 'org' as const, alias: 'right', displayName: 'right' }];
    const client = { runJson: async () => ({ result: [
      { SubscriberPackageId: '033000000000001', SubscriberPackageName: 'First', SubscriberPackageNamespace: 'first' },
      { SubscriberPackageId: '033000000000002', SubscriberPackageName: 'Second', SubscriberPackageNamespace: 'second' },
      { SubscriberPackageId: '033000000000003', SubscriberPackageName: 'Unlocked', SubscriberPackageNamespace: null },
      { SubscriberPackageId: '033000000000004', SubscriberPackageName: 'Shared A', SubscriberPackageNamespace: 'shared' },
      { SubscriberPackageId: '033000000000005', SubscriberPackageName: 'Shared B', SubscriberPackageNamespace: 'shared' },
    ] }) };
    const packages = await listInstalledPackages(sources, client, process.cwd());
    expect(packages).toHaveLength(5);
    expect(packages.find((entry) => entry.id === '033000000000001')).toMatchObject({ orgAliases: ['left', 'right'] });
    expect(await resolvePackageExclusion(sources, client, process.cwd(), undefined, ['033000000000002']))
      .toEqual({ namespaces: ['second'], unnamespacedPackages: [], selectedPackages: [{ id: '033000000000002', name: 'Second' }] });
    for (const id of ['033000000000099', '033000000000003', '033000000000004']) {
      await expect(resolvePackageExclusion(sources, client, process.cwd(), undefined, [id]))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(validateExcludedPackageIds(['033000000000002', '033000000000001', '033000000000002']))
      .toEqual(['033000000000001', '033000000000002']);
    for (const value of ['033000000000001', ['bad'], [null], Array(201).fill('033000000000001')]) {
      expect(() => validateExcludedPackageIds(value)).toThrow();
    }
  });

  it.each([{}, { result: {} }, { result: [{}] }, { result: [{ SubscriberPackageName: 'Broken', SubscriberPackageNamespace: '*' }] }])(
    'fails closed for an invalid inventory: %j', async (response) => {
      await expect(resolvePackageExclusion([{ kind: 'org', alias: 'org', displayName: 'org' }],
        { runJson: async () => response }, process.cwd())).rejects.toMatchObject({ code: 'SF_RESPONSE_INVALID' });
    },
  );

  it('requires an org and propagates inventory permission errors', async () => {
    await expect(resolvePackageExclusion([], { runJson: async () => ({ result: [] }) }, process.cwd()))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(resolvePackageExclusion([{ kind: 'org', alias: 'org', displayName: 'org' }],
      { runJson: async () => { throw new Error('permission denied'); } }, process.cwd())).rejects.toThrow('permission denied');
  });

  it.each([
    ['ApexClass', 'pkg__Class', true], ['CustomField', 'pkg__Object__c.Local__c', false],
    ['CustomField', 'Account.pkg__Field__c', true], ['CustomField', 'pkg__Object__c.pkg__Field__c', true],
    ['Report', 'Folder/pkg__Report', true], ['Report', 'pkg__Folder/LocalReport', false],
    ['Layout', 'pkg__Object__c-Local Layout', false], ['Layout', 'Account-pkg__Layout', true],
    ['LightningComponentBundle', 'pkg__Bundle', true], ['ApexClass', 'Local__c', false],
    ['ApexClass', 'other__Class', false], ['ApexClass', 'prefixpkg__Class', false],
    ['ApexClass', 'pkgSuffix__Class', false],
  ])('excludes package-owned %s: %s', (type, fullName, expected) => {
    expect(belongsToPackage(fullName, ['pkg'], type)).toBe(expected);
  });

  it('filters both sides before file limits and summaries, preserves originals and keeps the default comparison', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-exclusion-'));
    directories.push(root);
    const left = path.join(root, 'left');
    const right = path.join(root, 'right');
    await writeFixtureFiles(left, {
      'classes/pkg__Shared.cls': 'old package', 'classes/pkg__Shared.cls-meta.xml': '<ApexClass/>',
      'classes/pkg__LeftOnly.cls': 'left package', 'classes/Local.cls': 'old local',
    });
    await writeFixtureFiles(right, {
      'classes/pkg__Shared.cls': 'new package', 'classes/pkg__Shared.cls-meta.xml': '<ApexClass/>',
      'classes/pkg__RightOnly.cls': 'right package', 'classes/Local.cls': 'new local',
    });
    const snapshot = (packageRoot: string): MetadataSnapshot => ({
      source: { kind: 'local', projectPath: packageRoot, displayName: packageRoot }, packageRoot,
      manifestPath: 'package.xml', manifestSha256: 'same-manifest', payloadSha256: 'raw-payload', createdAt: '',
    });
    const included = await compareSnapshots(snapshot(left), snapshot(right));
    expect(included.summary).toMatchObject({ total: 4, modified: 2, added: 1, removed: 1 });
    const excluded = await compareSnapshots(snapshot(left), snapshot(right), {
      maximumFiles: 1, packageExclusion: { namespaces: ['pkg'], unnamespacedPackages: ['Unlocked'] },
    });
    expect(excluded.summary).toMatchObject({ total: 1, modified: 1, added: 0, removed: 0 });
    expect(excluded.comparisonLimit).toEqual({ maximumFiles: 1, fileCount: 1, exceeded: false });
    expect(excluded.packageExclusion?.excludedComponents).toBe(3);
    expect(excluded.warnings.join('\n')).toContain('네임스페이스가 없어 제외하지 않은 패키지: Unlocked');
    expect(excluded.components[0]?.key).toBe('ApexClass:Local');
    expect(await readFile(path.join(right, 'classes/pkg__Shared.cls'), 'utf8')).toBe('new package');
    await writeFixtureFiles(right, { 'classes/SecondLocal.cls': 'keep' });
    const inventory = await compareSnapshots(snapshot(left), snapshot(right), {
      maximumFiles: 1, packageExclusion: { namespaces: ['pkg'], unnamespacedPackages: [] },
    });
    expect(inventory.left.payloadSha256).toBe('raw-payload');
    expect(inventory.comparisonLimit?.exceeded).toBe(true);
    expect(inventory.components.map((component) => component.fullName)).toEqual(['Local', 'SecondLocal']);
    expect(inventory.components.every((component) => component.status === 'SOURCE')).toBe(true);
  });
});
