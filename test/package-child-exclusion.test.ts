import type { MetadataSnapshot } from '../src/sources/model.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Directory } from '../src/core/files.js';
import { compareSnapshots, type CompareOptions } from '../src/metadata/comparator.js';

import { writeFixtureFiles } from './support/files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const exclusion = { namespaces: [], unnamespacedPackages: [], componentKeys: [
  'CustomField:Account.Owned__c', 'ValidationRule:Account.OwnedRule', 'CustomLabel:OwnedLabel',
] };
async function snapshots(xml: (side: string) => string, labels?: (side: string) => string): Promise<[MetadataSnapshot, MetadataSnapshot]> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-child-exclusion-'));
  roots.push(root);
  const result: MetadataSnapshot[] = [];
  for (const side of ['left', 'right']) {
    const directory = path.join(root, side);
    await writeFixtureFiles(directory, { 'package.xml': '<Package/>', 'objects/Account.object': xml(side),
      ...(labels === undefined ? {} : { 'labels/CustomLabels.labels': labels(side) }),
    });
    result.push({ source: { kind: 'local', projectPath: directory, displayName: side }, packageRoot: directory,
      manifestPath: path.join(directory, 'package.xml'), manifestSha256: 'same', payloadSha256: 'original', createdAt: '' });
  }
  return result as [MetadataSnapshot, MetadataSnapshot];
}
const field = (name: string, label: string) => `<fields><fullName>${name}</fullName><label>${label}</label><type>Text</type></fields>`;

describe('embedded package member exclusions', () => {
  it.each<CompareOptions>([{}, { metadataType: 'CustomObject' }, { componentKeys: ['CustomObject:Account', 'CustomLabels:CustomLabels'] }])(
    'ignores selected fields, rules and labels while retaining parent content and original payloads (%j)', async (options) => {
      const pair = await snapshots((side) => `<CustomObject><label>Account</label>${field('Owned__c', side)}${field('Keep__c', 'Keep')}<validationRules><fullName>OwnedRule</fullName><errorMessage>${side}</errorMessage></validationRules></CustomObject>`,
        (side) => `<CustomLabels><labels><fullName>OwnedLabel</fullName><value>${side}</value></labels><labels><fullName>KeepLabel</fullName><value>Keep</value></labels></CustomLabels>`);
      const before = await Promise.all(pair.map((snapshot) => sha256Directory(snapshot.packageRoot)));
      const result = await compareSnapshots(...pair, { ...options, packageExclusion: exclusion, strict: true });
      expect(result.summary).toMatchObject({ total: 2, identical: 2, modified: 0 });
      expect(result.packageExclusion?.excludedComponents).toBe(3);
      expect(await Promise.all(pair.map((snapshot) => sha256Directory(snapshot.packageRoot)))).toEqual(before);
      expect(result.left.payloadSha256).toBe('original');
    },
  );
  it('keeps differences in another package or local field, and excludes only the selected child scope', async () => {
    const pair = await snapshots((side) => `<CustomObject><label>Account</label>${field('Owned__c', side)}${field('OtherPackage__c', side)}${field('Keep__c', 'Keep')}</CustomObject>`);
    const parent = await compareSnapshots(...pair, { metadataType: 'CustomObject', packageExclusion: exclusion });
    expect(parent.components[0]).toMatchObject({ key: 'CustomObject:Account', status: 'MODIFIED' });
    expect(JSON.stringify(parent.components[0]?.files.flatMap((file) => file.xmlChanges ?? []))).toContain('OtherPackage__c');
    const child = await compareSnapshots(...pair, { metadataType: 'CustomField', packageExclusion: exclusion });
    expect(child.components.map((component) => component.key).sort()).toEqual(['CustomField:Account.Keep__c', 'CustomField:Account.OtherPackage__c']);
    expect(child.packageExclusion?.excludedComponents).toBe(1);
    const unrelated = await compareSnapshots(...pair, { componentKeys: ['CustomField:Account.Keep__c'], packageExclusion: exclusion });
    expect(unrelated.packageExclusion?.excludedComponents).toBe(0);
  });
  it('streams large added/removed children and preserves strict formatting differences outside excluded members', async () => {
    const padding = '한글😀'.repeat(180_000);
    const pair = await snapshots((side) => side === 'left'
      ? `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\r\n  <label>Account</label>\r\n  <fields><fullName>Owned__c</fullName><description>${padding}</description></fields>\r\n</CustomObject>`
      : '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n  <label>Account</label>\n</CustomObject>');
    const result = await compareSnapshots(...pair, { metadataType: 'CustomObject', packageExclusion: exclusion, strict: true });
    expect(result.summary).toMatchObject({ identical: 1, modified: 0 });
    expect(result.packageExclusion?.excludedComponents).toBe(1);
    const formatted = await snapshots((side) => `<CustomObject xmlns=${side === 'left' ? '"http://soap.sforce.com/2006/04/metadata"' : "'http://soap.sforce.com/2006/04/metadata'"}><label>Account</label>${field('Owned__c', side)}</CustomObject>`);
    expect((await compareSnapshots(...formatted, { metadataType: 'CustomObject', packageExclusion: exclusion })).summary.identical).toBe(1);
    expect((await compareSnapshots(...formatted, { metadataType: 'CustomObject', packageExclusion: exclusion, strict: true })).summary.modified).toBe(1);
    expect(await readFile(path.join(pair[0].packageRoot, 'objects/Account.object'), 'utf8')).toContain(padding);
  });
});
