import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retrievePackageComponents } from '../src/metadata/package-components.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('reference package component retrieval', () => {
  const roots: string[] = [];
  afterEach(() => removeDirectoriesAfterTest(roots));
  it('extracts explicit members and embedded children, uses isolated output, and removes the downloaded sources', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-components-'));
    roots.push(root);
    await writeFixtureFiles(root, { 'sfdx-project.json': '{"sourceApiVersion":"67.0"}', 'force-app/keep.txt': 'unchanged' });
    let workspace = '';
    const members = await retrievePackageComponents('Unlocked CRM', 'dev', { runJson: async (args, options) => {
      workspace = options.cwd;
      expect(workspace).not.toBe(root);
      expect(args).toEqual(expect.arrayContaining(['--package-name', 'Unlocked CRM', '--target-org', 'dev', '--unzip']));
      expect(args).not.toContain('--manifest');
      const output = args[args.indexOf('--target-metadata-dir') + 1]!;
      await writeFixtureFiles(path.join(output, 'Unlocked CRM'), {
        'package.xml': '<Package><fullName>Unlocked CRM</fullName><types><members>Owned</members><name>ApexClass</name></types><types><members>Thing__c</members><name>CustomObject</name></types><types><members>CustomLabels</members><name>CustomLabels</name></types><version>67.0</version></Package>',
        'objects/Thing__c.object': '<CustomObject><fields><fullName>Owned__c</fullName><type>Text</type></fields><validationRules><fullName>Check</fullName></validationRules></CustomObject>',
        'objects/Dependency__c.object': '<CustomObject><fields><fullName>Keep__c</fullName></fields></CustomObject>',
        'labels/CustomLabels.labels': '<CustomLabels><labels><fullName>Owned_Label</fullName><value>Example</value></labels></CustomLabels>',
      });
      return { result: { success: true, done: true, messages: [] } };
    } }, root);
    expect(members).toEqual([
      { type: 'ApexClass', fullName: 'Owned' }, { type: 'CustomField', fullName: 'Thing__c.Owned__c' },
      { type: 'CustomLabel', fullName: 'Owned_Label' }, { type: 'CustomLabels', fullName: 'CustomLabels' },
      { type: 'CustomObject', fullName: 'Thing__c' }, { type: 'ValidationRule', fullName: 'Thing__c.Check' },
    ]);
    await expect(access(workspace)).rejects.toThrow();
    await expect(access(path.join(root, 'force-app/keep.txt'))).resolves.toBeUndefined();
  });
  it.each([
    ['<Package><types><members>*</members><name>ApexClass</name></types></Package>', { success: true }],
    ['<Package><types><members>Owned</members><name>ApexClass</name></types></Package>', { success: true, messages: [{ problem: 'partial retrieval' }] }],
    ['<Package><types><members>Owned</members><name>ApexClass</name></types></Package>', { success: true, done: false }],
    ['<Package/>', { success: true }],
    ['<Package><types>', { success: true }],
    ['<!DOCTYPE Package><Package/>', { success: true }],
    ['<Package><fullName>Wrong</fullName><types><members>A</members><name>ApexClass</name></types></Package>', { success: true }],
  ])('rejects ambiguous, malformed or incomplete membership (%s)', async (xml, result) => {
    await expect(retrievePackageComponents('Package', 'dev', { runJson: async (args) => {
      await writeFixtureFiles(path.join(args[args.indexOf('--target-metadata-dir') + 1]!, 'Package'), { 'package.xml': xml });
      return { result };
    } }, process.cwd())).rejects.toMatchObject({ code: 'SF_RESPONSE_INVALID' });
  });
});
