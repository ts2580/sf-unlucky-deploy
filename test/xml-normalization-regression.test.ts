import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compareXml } from '../src/metadata/xml-diff.js';
import { compareSnapshots, MAX_DIFF_INPUT_BYTES } from '../src/metadata/comparator.js';
import { normalizedTextHash } from '../src/metadata/normalized-text-hash.js';
import type { SourceSpec } from '../src/sources/source-spec.js';
import type { MetadataSnapshot } from '../src/sources/snapshot.js';
import { removeDirectoriesAfterTest, writeFixtureFiles } from './support/files.js';

describe('XML normalization regressions', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => removeDirectoriesAfterTest(temporaryDirectories));

  it('ignores XML sibling property and attribute order', () => {
    const left = '<Root beta="2" alpha="1"><first>1</first><second>2</second></Root>';
    const right = '<Root alpha="1" beta="2"><second>2</second><first>1</first></Root>';

    expect(compareXml(left, right)).toEqual([]);
  });

  it('matches PermissionSet fieldPermissions when one item grows to two', () => {
    const left = permissionSet(
      '<fieldPermissions><field>Account.Name</field><editable>true</editable></fieldPermissions>',
    );
    const right = permissionSet(
      '<fieldPermissions><field>Contact.Email</field><editable>true</editable></fieldPermissions>'
      + '<fieldPermissions><field>Account.Name</field><editable>false</editable></fieldPermissions>',
    );

    const changes = compareXml(left, right, { metadataType: 'PermissionSet' });

    expect(changes).toContainEqual({
      kind: 'MODIFIED',
      path: 'PermissionSet.fieldPermissions[field=Account.Name].editable',
      before: 'true',
      after: 'false',
    });
    expect(changes.some((change) => change.kind === 'ADDED'
      && change.path === 'PermissionSet.fieldPermissions[field=Contact.Email]')).toBe(true);
    expect(changes.some((change) => change.kind === 'REORDERED')).toBe(false);
    expect(changes.some((change) => change.kind === 'MODIFIED'
      && change.path === 'PermissionSet.fieldPermissions')).toBe(false);
  });

  it('matches PermissionSet fieldPermissions when two items shrink to one', () => {
    const left = permissionSet(
      '<fieldPermissions><field>Account.Name</field><editable>true</editable></fieldPermissions>'
      + '<fieldPermissions><field>Contact.Email</field><editable>true</editable></fieldPermissions>',
    );
    const right = permissionSet(
      '<fieldPermissions><field>Account.Name</field><editable>false</editable></fieldPermissions>',
    );

    const changes = compareXml(left, right, { metadataType: 'PermissionSet' });

    expect(changes).toContainEqual({
      kind: 'MODIFIED',
      path: 'PermissionSet.fieldPermissions[field=Account.Name].editable',
      before: 'true',
      after: 'false',
    });
    expect(changes.some((change) => change.kind === 'REMOVED'
      && change.path === 'PermissionSet.fieldPermissions[field=Contact.Email]')).toBe(true);
    expect(changes.some((change) => change.kind === 'REORDERED')).toBe(false);
  });

  it('reports a singleton replacement as removed and added identities', () => {
    const left = permissionSet(
      '<fieldPermissions><field>Account.Name</field><editable>true</editable></fieldPermissions>',
    );
    const right = permissionSet(
      '<fieldPermissions><field>Contact.Email</field><editable>true</editable></fieldPermissions>',
    );

    const changes = compareXml(left, right, { metadataType: 'PermissionSet' });

    expect(changes.some((change) => change.kind === 'REMOVED'
      && change.path === 'PermissionSet.fieldPermissions[field=Account.Name]')).toBe(true);
    expect(changes.some((change) => change.kind === 'ADDED'
      && change.path === 'PermissionSet.fieldPermissions[field=Contact.Email]')).toBe(true);
    expect(changes.some((change) => change.kind === 'MODIFIED'
      && change.path === 'PermissionSet.fieldPermissions[field=Account.Name].field')).toBe(false);
  });

  it('matches CustomObject fields by fullName without reporting growth as reorder', () => {
    const left = customObject(
      '<fields><fullName>Status__c</fullName><label>Status</label></fields>',
    );
    const right = customObject(
      '<fields><fullName>Owner__c</fullName><label>Owner</label></fields>'
      + '<fields><fullName>Status__c</fullName><label>Status</label></fields>',
    );

    const changes = compareXml(left, right, { metadataType: 'CustomObject' });

    expect(changes.some((change) => change.kind === 'ADDED'
      && change.path === 'CustomObject.fields[fullName=Owner__c]')).toBe(true);
    expect(changes.some((change) => change.kind === 'REORDERED')).toBe(false);
    expect(changes.some((change) => change.kind === 'MODIFIED'
      && change.path.includes('Status__c'))).toBe(false);
  });

  it('ignores order changes between two existing CustomObject fields', () => {
    const left = customObject(
      '<fields><fullName>Status__c</fullName><label>Status</label></fields>'
      + '<fields><fullName>Owner__c</fullName><label>Owner</label></fields>',
    );
    const right = customObject(
      '<fields><fullName>Owner__c</fullName><label>Owner</label></fields>'
      + '<fields><fullName>Status__c</fullName><label>Status</label></fields>',
    );

    expect(compareXml(left, right, { metadataType: 'CustomObject' })).toEqual([]);
  });

  it('ignores order changes between two existing PermissionSet fieldPermissions', () => {
    const left = permissionSet(
      '<fieldPermissions><field>Account.Name</field><editable>true</editable></fieldPermissions>'
      + '<fieldPermissions><field>Contact.Email</field><editable>false</editable></fieldPermissions>',
    );
    const right = permissionSet(
      '<fieldPermissions><field>Contact.Email</field><editable>false</editable></fieldPermissions>'
      + '<fieldPermissions><field>Account.Name</field><editable>true</editable></fieldPermissions>',
    );

    expect(compareXml(left, right, { metadataType: 'PermissionSet' })).toEqual([]);
  });

  it('uses layout and recordType together as Profile layout assignment identity', () => {
    const left = profile(
      '<layoutAssignments><layout>Account-Layout</layout><recordType>Retail</recordType><default>true</default></layoutAssignments>'
      + '<layoutAssignments><layout>Account-Layout</layout><recordType>Wholesale</recordType><default>false</default></layoutAssignments>',
    );
    const right = profile(
      '<layoutAssignments><layout>Account-Layout</layout><recordType>Wholesale</recordType><default>false</default></layoutAssignments>'
      + '<layoutAssignments><layout>Account-Layout</layout><recordType>Retail</recordType><default>false</default></layoutAssignments>',
    );

    const changes = compareXml(left, right, { metadataType: 'Profile' });

    expect(changes).toEqual([{
      kind: 'MODIFIED',
      path: 'Profile.layoutAssignments[layout=Account-Layout|recordType=Retail].default',
      before: 'true',
      after: 'false',
    }]);
  });

  it('preserves order for generic arrays without an identity key', () => {
    const left = '<Unknown><items><value>A</value></items><items><value>B</value></items></Unknown>';
    const right = '<Unknown><items><value>B</value></items><items><value>A</value></items></Unknown>';

    const changes = compareXml(left, right, { metadataType: 'UnknownMetadata' });

    expect(changes).toEqual([
      { kind: 'MODIFIED', path: 'Unknown.items[0].value', before: 'A', after: 'B' },
      { kind: 'MODIFIED', path: 'Unknown.items[1].value', before: 'B', after: 'A' },
    ]);
  });

  it('preserves ordered Layout sections when a singleton grows', () => {
    const left = '<Layout><layoutSections><label>General</label></layoutSections></Layout>';
    const right = '<Layout><layoutSections><label>General</label></layoutSections>'
      + '<layoutSections><label>Details</label></layoutSections></Layout>';

    const changes = compareXml(left, right, { metadataType: 'Layout' });

    expect(changes.some((change) => change.kind === 'ADDED'
      && change.path === 'Layout.layoutSections[label=Details]')).toBe(true);
    expect(changes.some((change) => change.kind === 'REORDERED')).toBe(false);
    expect(changes.some((change) => change.kind === 'MODIFIED'
      && change.path.includes('General'))).toBe(false);
  });

  it('retains CustomField picklist value order as semantic order', () => {
    const left = customField(
      '<value><fullName>New</fullName><default>false</default></value>'
      + '<value><fullName>Closed</fullName><default>false</default></value>',
    );
    const right = customField(
      '<value><fullName>Closed</fullName><default>false</default></value>'
      + '<value><fullName>New</fullName><default>false</default></value>',
    );

    expect(compareXml(left, right, { metadataType: 'CustomField' })).toContainEqual({
      kind: 'REORDERED',
      path: 'CustomField.valueSet.valueSetDefinition.value.$order',
      before: 'fullName=New, fullName=Closed',
      after: 'fullName=Closed, fullName=New',
    });
  });

  it.each([
    ['text', 'classes/LineEndings.cls', 'public class LineEndings {\n  String value = \'same\';\n}\n'],
    ['xml', 'profiles/LineEndings.profile', '<?xml version="1.0"?>\n<Profile><enabled>true</enabled></Profile>\n'],
  ])('treats LF and CRLF as identical in normal and strict %s comparisons', async (_kind, relativePath, logical) => {
    const root = await createComparisonRoots(temporaryDirectories);
    await Promise.all([
      writeFixtureFiles(root.left, { 'package.xml': '<Package/>', [relativePath]: logical }),
      writeFixtureFiles(root.right, {
        'package.xml': '<Package/>',
        [relativePath]: logical.replace(/\n/gu, '\r\n'),
      }),
    ]);

    const [normal, strict] = await Promise.all([
      compareSnapshots(snapshot(root.left, 'lf'), snapshot(root.right, 'crlf')),
      compareSnapshots(snapshot(root.left, 'lf'), snapshot(root.right, 'crlf'), { strict: true }),
    ]);
    const normalFile = normal.components[0]?.files[0];
    const strictFile = strict.components[0]?.files[0];

    expect(normalFile).toMatchObject({ status: 'IDENTICAL' });
    expect(strictFile).toMatchObject({ status: 'IDENTICAL' });
    if (_kind === 'xml') {
      expect(normalFile).toMatchObject({ xmlSemanticStatus: 'EQUAL', rawContentChanged: true });
      expect(strictFile).toMatchObject({ xmlSemanticStatus: 'EQUAL', rawContentChanged: true });
    }
  });

  it('normalizes CRLF and LF for large text and XML while retaining raw hashes', async () => {
    const root = await createComparisonRoots(temporaryDirectories);
    const logical = `${'x'.repeat(MAX_DIFF_INPUT_BYTES + 4096)}\n경계😀\n끝\n`;
    const crlf = logical.replace(/\n/gu, '\r\n');
    await Promise.all([
      writeFixtureFiles(root.left, {
        'package.xml': '<Package/>',
        'classes/Large.cls': logical,
        'docs/Large.xml': `<Root><text>${logical}</text></Root>`,
      }),
      writeFixtureFiles(root.right, {
        'package.xml': '<Package/>',
        'classes/Large.cls': crlf,
        'docs/Large.xml': `<Root><text>${crlf}</text></Root>`,
      }),
    ]);

    const result = await compareSnapshots(snapshot(root.left, 'lf'), snapshot(root.right, 'crlf'), {
      strict: true,
    });
    const files = result.components.flatMap((component) => component.files);

    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file.status).toBe('IDENTICAL');
      expect(file.leftSha256).toBeDefined();
      expect(file.rightSha256).toBeDefined();
      expect(file.leftSha256).not.toBe(file.rightSha256);
    }
  });

  it('keeps binary NUL and invalid UTF-8 differences byte-sensitive', async () => {
    const root = await createComparisonRoots(temporaryDirectories);
    await Promise.all([
      writeFixtureFiles(root.left, {
        'package.xml': '<Package/>',
        'staticresources/blob.resource': Buffer.from([0, 0xff, 0, 1]),
      }),
      writeFixtureFiles(root.right, {
        'package.xml': '<Package/>',
        'staticresources/blob.resource': Buffer.from([0, 0xfe, 0, 1]),
      }),
    ]);

    const result = await compareSnapshots(snapshot(root.left, 'left'), snapshot(root.right, 'right'));

    expect(result.components[0]?.files[0]).toMatchObject({
      status: 'MODIFIED',
      kind: 'binary',
    });
  });

  it('normalizes BOM and CRLF across streaming chunk and multibyte boundaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-normalized-hash-'));
    temporaryDirectories.push(root);
    const crLeft = path.join(root, 'cr-left.txt');
    const crRight = path.join(root, 'cr-right.txt');
    const unicodeLeft = path.join(root, 'unicode-left.txt');
    const unicodeRight = path.join(root, 'unicode-right.txt');
    const bomLeft = path.join(root, 'bom-left.txt');
    const bomRight = path.join(root, 'bom-right.txt');

    // The CR is byte 65535 (the final byte of the default 64 KiB read chunk),
    // with its LF in the following chunk.
    await Promise.all([
      writeFile(crLeft, `${'a'.repeat(65535)}\n끝`),
      writeFile(crRight, `${'a'.repeat(65535)}\r\n끝`),
      // The four-byte emoji starts at byte 65534 and is decoded across chunks.
      writeFile(unicodeLeft, `${'a'.repeat(65534)}😀\n한글`),
      writeFile(unicodeRight, `${'a'.repeat(65534)}😀\r\n한글`),
      writeFile(bomLeft, 'same\ntext'),
      writeFile(bomRight, '\uFEFFsame\r\ntext'),
    ]);

    const [crLeftHash, crRightHash, unicodeLeftHash, unicodeRightHash, bomLeftHash, bomRightHash] =
      await Promise.all([
        normalizedTextHash(crLeft),
        normalizedTextHash(crRight),
        normalizedTextHash(unicodeLeft),
        normalizedTextHash(unicodeRight),
        normalizedTextHash(bomLeft),
        normalizedTextHash(bomRight),
      ]);

    expect(crLeftHash).toBe(crRightHash);
    expect(unicodeLeftHash).toBe(unicodeRightHash);
    expect(bomLeftHash).toBe(bomRightHash);
  });

  it('keeps large NUL and invalid UTF-8 payloads byte-sensitive', async () => {
    const root = await createComparisonRoots(temporaryDirectories);
    const size = MAX_DIFF_INPUT_BYTES + 4096;
    const nulLeft = Buffer.alloc(size, 0x61);
    const nulRight = Buffer.from(nulLeft);
    nulLeft[65535] = 0;
    nulLeft[65536] = 0xff;
    nulRight[65535] = 0;
    nulRight[65536] = 0xfe;
    const invalidLeft = Buffer.alloc(size, 0x61);
    const invalidRight = Buffer.from(invalidLeft);
    invalidLeft[65535] = 0xff;
    invalidRight[65535] = 0xfe;
    await Promise.all([
      writeFixtureFiles(root.left, {
        'package.xml': '<Package/>',
        'classes/LargeNul.cls': nulLeft,
        'classes/LargeInvalid.cls': invalidLeft,
      }),
      writeFixtureFiles(root.right, {
        'package.xml': '<Package/>',
        'classes/LargeNul.cls': nulRight,
        'classes/LargeInvalid.cls': invalidRight,
      }),
    ]);

    const result = await compareSnapshots(snapshot(root.left, 'left'), snapshot(root.right, 'right'));
    const files = result.components.flatMap((component) => component.files);

    expect(files).toHaveLength(2);
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'classes/LargeNul.cls', status: 'MODIFIED', kind: 'binary' }),
      expect.objectContaining({ path: 'classes/LargeInvalid.cls', status: 'MODIFIED', kind: 'binary' }),
    ]));
  });
});

function permissionSet(children: string): string {
  return `<PermissionSet>${children}</PermissionSet>`;
}

function customObject(children: string): string {
  return `<CustomObject>${children}</CustomObject>`;
}

function profile(children: string): string {
  return `<Profile>${children}</Profile>`;
}

function customField(values: string): string {
  return `<CustomField><valueSet><valueSetDefinition>${values}</valueSetDefinition></valueSet></CustomField>`;
}

async function createComparisonRoots(temporaryDirectories: string[]): Promise<{ left: string; right: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-xml-normalization-'));
  temporaryDirectories.push(root);
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  await Promise.all([mkdir(left), mkdir(right)]);
  return { left, right };
}

function snapshot(packageRoot: string, name: string): MetadataSnapshot {
  const source: SourceSpec = { kind: 'local', projectPath: packageRoot, displayName: `local:${name}` };
  return {
    source,
    packageRoot,
    manifestPath: path.join(packageRoot, 'package.xml'),
    manifestSha256: 'same-manifest',
    payloadSha256: `payload-${name}`,
    createdAt: new Date(0).toISOString(),
  };
}
