import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256Directory, sha256File } from '../src/core/files.js';
import { projectChildMetadata } from '../src/metadata/child-metadata-projection.js';
import { compareSnapshots } from '../src/metadata/comparator.js';
import type { MetadataSnapshot } from '../src/sources/snapshot.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
const manifest = '<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>64.0</version></Package>\n';
const XML_SIZE_THRESHOLD = 1024 * 1024;
const CHILD_XML_SIZE_THRESHOLD = 16 * 1024 * 1024;

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function snapshot(root: string, files: Record<string, string>): Promise<MetadataSnapshot> {
  await mkdir(root, { recursive: true });
  const manifestPath = path.join(root, 'package.xml');
  await writeFile(manifestPath, manifest);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return {
    source: { kind: 'local', projectPath: root, displayName: `local:${root}` },
    packageRoot: root,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    payloadSha256: await sha256Directory(root),
    createdAt: new Date(0).toISOString(),
  };
}

function paddedXml(root: string, body: string, padding = 1_100_000): string {
  const xml = `<${root} xmlns="http://soap.sforce.com/2006/04/metadata"><description>${'x'.repeat(padding)}</description>${body}</${root}>`;
  expect(Buffer.byteLength(xml)).toBeGreaterThan(XML_SIZE_THRESHOLD);
  return xml;
}

function permissionSetXml(entries: string, padding = 1_100_000): string {
  return paddedXml('PermissionSet', entries, padding);
}

function profileXml(entries: string, padding = 1_100_000): string {
  return paddedXml('Profile', entries, padding);
}

function fieldPermission(name: string, read: boolean): string {
  return `<fieldPermissions><field>${name}</field><editable>false</editable><read>${String(read)}</read></fieldPermissions>`;
}

function objectPermission(name: string, read: boolean): string {
  return `<objectPermissions><object>${name}</object><allowRead>${String(read)}</allowRead></objectPermissions>`;
}

function layoutXml(labels: readonly string[], padding = 1_100_000): string {
  const sections = labels.map((label) => `<layoutSections><label>${label}</label><layoutColumns><layoutItems><field>${label}__c</field></layoutItems></layoutColumns></layoutSections>`).join('');
  return paddedXml('Layout', sections, padding);
}

function picklistObjectXml(values: readonly string[], padding = 1_100_000): string {
  const picklistValues = values.map((value) => `<picklistValues><fullName>${value}</fullName><default>false</default><label>${value}</label></picklistValues>`).join('');
  return paddedXml('CustomObject', `<fields><fullName>Status__c</fullName><label>Status</label><type>Picklist</type><picklist>${picklistValues}</picklist></fields>`, padding);
}

function fileOf(result: Awaited<ReturnType<typeof compareSnapshots>>, key: string) {
  const component = result.components.find((entry) => entry.key === key);
  expect(component).toBeDefined();
  const file = component?.files[0];
  expect(file).toBeDefined();
  return file!;
}

describe('large XML comparison', { timeout: 120_000 }, () => {
  it('PermissionSet unordered policy treats a reordered >1MiB collection as semantically equal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-permission-order-'));
    const leftXml = permissionSetXml([
      fieldPermission('A__c', true),
      fieldPermission('B__c', false),
      fieldPermission('C__c', true),
    ].join(''));
    const rightXml = permissionSetXml([
      fieldPermission('C__c', true),
      fieldPermission('A__c', true),
      fieldPermission('B__c', false),
    ].join(''));
    const left = await snapshot(`${root}-left`, { 'permissionsets/Big.permissionset': leftXml });
    const right = await snapshot(`${root}-right`, { 'permissionsets/Big.permissionset': rightXml });
    roots.push(root, `${root}-left`, `${root}-right`);

    const result = await compareSnapshots(left, right);
    const file = fileOf(result, 'PermissionSet:Big');
    expect(result.summary).toMatchObject({ identical: 1, different: 0 });
    expect(file).toMatchObject({
      status: 'IDENTICAL',
      xmlSemanticStatus: 'EQUAL',
      xmlComparisonPolicy: 'REGISTERED',
      rawContentChanged: true,
    });
    expect(file.leftSha256).not.toBe(file.rightSha256);
  });

  it('ordered Layout and picklist policies preserve meaningful reorder in large XML', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-ordered-'));
    const layoutLeft = layoutXml(['First', 'Second', 'Third']);
    const layoutRight = layoutXml(['Second', 'First', 'Third']);
    const picklistLeft = picklistObjectXml(['One', 'Two', 'Three']);
    const picklistRight = picklistObjectXml(['Two', 'One', 'Three']);
    const left = await snapshot(`${root}-left`, {
      'layouts/Big.layout': layoutLeft,
      'objects/Big.object': picklistLeft,
    });
    const right = await snapshot(`${root}-right`, {
      'layouts/Big.layout': layoutRight,
      'objects/Big.object': picklistRight,
    });
    roots.push(root, `${root}-left`, `${root}-right`);

    const result = await compareSnapshots(left, right);
    expect(fileOf(result, 'Layout:Big')).toMatchObject({ status: 'MODIFIED', xmlSemanticStatus: 'DIFFERENT', xmlComparisonPolicy: 'REGISTERED' });
    expect(fileOf(result, 'CustomObject:Big')).toMatchObject({ status: 'MODIFIED', xmlSemanticStatus: 'DIFFERENT', xmlComparisonPolicy: 'REGISTERED' });
  });

  it('handles singleton collections and compares duplicate identities conservatively', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-singleton-'));
    const singletonLeft = permissionSetXml(fieldPermission('Only__c', true));
    const singletonRight = permissionSetXml(fieldPermission('Only__c', true));
    const duplicateLeft = permissionSetXml(`${fieldPermission('Duplicate__c', true)}${fieldPermission('Duplicate__c', false)}`);
    const duplicateRight = permissionSetXml(`${fieldPermission('Duplicate__c', false)}${fieldPermission('Duplicate__c', true)}`);
    const left = await snapshot(`${root}-left`, {
      'permissionsets/Singleton.permissionset': singletonLeft,
      'permissionsets/Duplicate.permissionset': duplicateLeft,
    });
    const right = await snapshot(`${root}-right`, {
      'permissionsets/Singleton.permissionset': singletonRight,
      'permissionsets/Duplicate.permissionset': duplicateRight,
    });
    roots.push(root, `${root}-left`, `${root}-right`);

    const result = await compareSnapshots(left, right);
    expect(fileOf(result, 'PermissionSet:Singleton')).toMatchObject({ status: 'IDENTICAL', xmlSemanticStatus: 'EQUAL' });
    expect(fileOf(result, 'PermissionSet:Duplicate')).toMatchObject({ status: 'MODIFIED', xmlSemanticStatus: 'DIFFERENT' });
  });

  it('detects changes in the tail after the 2000-detail budget and bounds details', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-tail-'));
    const names = Array.from({ length: 2_205 }, (_, index) => `Object${String(index).padStart(4, '0')}__c`);
    const leftEntries = names.map((name) => objectPermission(name, false)).join('');
    const rightEntries = names.map((name, index) => objectPermission(name, index === names.length - 1)).join('');
    const left = await snapshot(`${root}-left`, { 'profiles/Tail.profile': profileXml(leftEntries) });
    const right = await snapshot(`${root}-right`, { 'profiles/Tail.profile': profileXml(rightEntries) });
    roots.push(root, `${root}-left`, `${root}-right`);

    const result = await compareSnapshots(left, right);
    const file = fileOf(result, 'Profile:Tail');
    expect(file.status).toBe('MODIFIED');
    expect(file.xmlSemanticStatus).toBe('DIFFERENT');
    expect(file.xmlChanges).toBeDefined();
    expect(file.xmlChanges!.length).toBeLessThanOrEqual(2_000);
  });

  it('caps more than 2,000 actual large XML changes while retaining the modified status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-detail-cap-'));
    const names = Array.from({ length: 2_005 }, (_, index) => `Changed${String(index).padStart(4, '0')}__c`);
    const leftEntries = names.map((name) => objectPermission(name, false)).join('');
    const rightEntries = names.map((name) => objectPermission(name, true)).join('');
    const left = await snapshot(`${root}-left`, { 'profiles/Cap.profile': profileXml(leftEntries) });
    const right = await snapshot(`${root}-right`, { 'profiles/Cap.profile': profileXml(rightEntries) });
    roots.push(root, `${root}-left`, `${root}-right`);

    const file = fileOf(await compareSnapshots(left, right), 'Profile:Cap');
    expect(file).toMatchObject({
      status: 'MODIFIED',
      xmlSemanticStatus: 'DIFFERENT',
      diffTruncated: true,
    });
    expect(file.xmlChanges).toHaveLength(2_000);
  });

  it('matches a reversed 12,000-item PermissionSet collection when the collection itself exceeds 1MiB', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-wide-collection-'));
    const names = Array.from({ length: 12_000 }, (_, index) => `Wide${String(index).padStart(5, '0')}__c`);
    const leftXml = permissionSetXml(names.map((name) => fieldPermission(name, true)).join(''), 0);
    const rightXml = permissionSetXml([...names].reverse().map((name) => fieldPermission(name, true)).join(''), 0);
    expect(Buffer.byteLength(leftXml)).toBeGreaterThan(XML_SIZE_THRESHOLD);
    const left = await snapshot(`${root}-left`, { 'permissionsets/Wide.permissionset': leftXml });
    const right = await snapshot(`${root}-right`, { 'permissionsets/Wide.permissionset': rightXml });
    roots.push(root, `${root}-left`, `${root}-right`);

    const result = await compareSnapshots(left, right);
    expect(fileOf(result, 'PermissionSet:Wide')).toMatchObject({
      status: 'IDENTICAL',
      xmlSemanticStatus: 'EQUAL',
      xmlComparisonPolicy: 'REGISTERED',
    });
  });

  it('uses normalized line endings in strict mode while formatting remains a modification', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-strict-'));
    const body = `${fieldPermission('Strict__c', true)}\n`;
    const leftXml = permissionSetXml(body);
    const crlfXml = leftXml.replace(/\n/gu, '\r\n');
    const formattedXml = crlfXml.replace('<description>', ' <description>');
    const left = await snapshot(`${root}-left`, { 'permissionsets/Strict.permissionset': leftXml });
    const crlf = await snapshot(`${root}-crlf`, { 'permissionsets/Strict.permissionset': crlfXml });
    const formatted = await snapshot(`${root}-formatted`, { 'permissionsets/Strict.permissionset': formattedXml });
    roots.push(root, `${root}-left`, `${root}-crlf`, `${root}-formatted`);

    const lineEndingResult = await compareSnapshots(left, crlf, { strict: true });
    expect(fileOf(lineEndingResult, 'PermissionSet:Strict')).toMatchObject({
      status: 'IDENTICAL',
      xmlSemanticStatus: 'EQUAL',
      rawContentChanged: true,
    });

    const formattingResult = await compareSnapshots(left, formatted, { strict: true });
    expect(fileOf(formattingResult, 'PermissionSet:Strict')).toMatchObject({
      status: 'MODIFIED',
      xmlSemanticStatus: 'EQUAL',
      rawContentChanged: true,
    });
  });

  it('keeps large SAX text and CDATA semantically equal across Unicode chunks, attributes, and XML declarations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-stream-parity-'));
    const unicode = '한字🙂'.repeat(220_000);
    const leftXml = `<?xml version="1.0" encoding="UTF-8"?><PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata" data-a="1" data-b="2"><description data-x="x" data-y="y">${unicode}</description><flag enabled="true"/></PermissionSet>`;
    const equalXml = `<PermissionSet data-b="2" data-a="1" xmlns="http://soap.sforce.com/2006/04/metadata"><description data-y="y" data-x="x"><![CDATA[${unicode}]]></description><flag enabled="true"/></PermissionSet>`;
    const changedXml = `<PermissionSet data-b="2" data-a="1" xmlns="http://soap.sforce.com/2006/04/metadata"><description data-y="y" data-x="x"><![CDATA[${unicode.slice(0, -1)}X]]></description><flag enabled="true"/></PermissionSet>`;
    expect(Buffer.byteLength(leftXml)).toBeGreaterThan(XML_SIZE_THRESHOLD);
    const left = await snapshot(`${root}-left`, { 'permissionsets/Stream.permissionset': leftXml });
    const equal = await snapshot(`${root}-equal`, { 'permissionsets/Stream.permissionset': equalXml });
    const changed = await snapshot(`${root}-changed`, { 'permissionsets/Stream.permissionset': changedXml });
    roots.push(root, `${root}-left`, `${root}-equal`, `${root}-changed`);

    const equalResult = await compareSnapshots(left, equal);
    expect(fileOf(equalResult, 'PermissionSet:Stream')).toMatchObject({
      status: 'IDENTICAL',
      xmlSemanticStatus: 'EQUAL',
      rawContentChanged: true,
    });

    const strictResult = await compareSnapshots(left, equal, { strict: true });
    expect(fileOf(strictResult, 'PermissionSet:Stream')).toMatchObject({
      status: 'MODIFIED',
      xmlSemanticStatus: 'EQUAL',
      rawContentChanged: true,
    });

    const changedResult = await compareSnapshots(left, changed);
    expect(fileOf(changedResult, 'PermissionSet:Stream')).toMatchObject({
      status: 'MODIFIED',
      xmlSemanticStatus: 'DIFFERENT',
    });
  });

  it('keeps small XML declaration and processing-instruction semantics aligned with the stream path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-small-xml-pi-'));
    const leftXml = '<?xml version="1.0" encoding="UTF-8"?><PermissionSet><?note ignored?><description>same</description></PermissionSet>';
    const rightXml = '<PermissionSet><description>same</description></PermissionSet>';
    const left = await snapshot(`${root}-left`, { 'permissionsets/Pi.permissionset': leftXml });
    const right = await snapshot(`${root}-right`, { 'permissionsets/Pi.permissionset': rightXml });
    roots.push(root, `${root}-left`, `${root}-right`);

    const semanticResult = await compareSnapshots(left, right);
    expect(fileOf(semanticResult, 'PermissionSet:Pi')).toMatchObject({
      status: 'IDENTICAL',
      xmlSemanticStatus: 'EQUAL',
    });
    const strictResult = await compareSnapshots(left, right, { strict: true });
    expect(fileOf(strictResult, 'PermissionSet:Pi')).toMatchObject({
      status: 'MODIFIED',
      xmlSemanticStatus: 'EQUAL',
    });
  });

  it('rejects DTDs in large XML instead of resolving external or custom entities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-dtd-'));
    const body = permissionSetXml(fieldPermission('Dtd__c', true));
    const dtdXml = `<!DOCTYPE PermissionSet [<!ENTITY injected "changed">]>${body}`;
    const left = await snapshot(`${root}-left`, { 'permissionsets/Dtd.permissionset': body });
    const right = await snapshot(`${root}-right`, { 'permissionsets/Dtd.permissionset': dtdXml });
    roots.push(root, `${root}-left`, `${root}-right`);

    await expect(compareSnapshots(left, right)).rejects.toThrow(/DTD|형식/u);
  });

  it('projects namespaced child metadata using local names and rejects duplicate identities with cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-stream-edge-'));
    const namespaced = '<md:CustomObject xmlns:md="http://soap.sforce.com/2006/04/metadata"><md:fields><md:fullName>Rating__c</md:fullName><md:label>Rating</md:label><md:type>Text</md:type></md:fields></md:CustomObject>';
    const duplicate = '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><fields><fullName>Same__c</fullName><label>One</label><type>Text</type></fields><fields><fullName>Same__c</fullName><label>Two</label><type>Text</type></fields></CustomObject>';
    const namespacedSnapshot = await snapshot(`${root}-namespaced`, { 'objects/Account.object': namespaced });
    const duplicateSnapshot = await snapshot(`${root}-duplicate`, { 'objects/Account.object': duplicate });
    roots.push(root, `${root}-namespaced`, `${root}-duplicate`);

    const projection = await projectChildMetadata(namespacedSnapshot, 'CustomField');
    try {
      const child = await readFile(path.join(projection.snapshot.packageRoot, 'CustomField', 'Account.Rating__c.xml'), 'utf8');
      expect(child).toContain('<fullName>Rating__c</fullName>');
      expect(child).toContain('<CustomField>');
    } finally {
      await projection.dispose();
    }

    const removed = vi.mocked(fileSystem.rm);
    removed.mockClear();
    await expect(projectChildMetadata(duplicateSnapshot, 'CustomField')).rejects.toThrow();
    const projectionPaths = removed.mock.calls.map(([entry]) => entry).filter((entry): entry is string =>
      typeof entry === 'string' && path.basename(entry).startsWith('sfud-child-compare-'));
    expect(projectionPaths).toHaveLength(1);
    await expect(fileSystem.access(projectionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects a >16MiB parent XML by child metadata and preserves the raw snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-child-'));
    const field = '<fields><fullName>Rating__c</fullName><label>Rating</label><type>Text</type></fields>';
    const parentXml = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><description>${'x'.repeat(CHILD_XML_SIZE_THRESHOLD + 1_024)}</description>${field}</CustomObject>`;
    expect(Buffer.byteLength(parentXml)).toBeGreaterThan(CHILD_XML_SIZE_THRESHOLD);
    const left = await snapshot(`${root}-left`, { 'objects/Account.object': parentXml });
    roots.push(root, `${root}-left`);
    const sourceParentSha256 = await sha256File(path.join(`${root}-left`, 'objects/Account.object'));

    const projection = await projectChildMetadata(left, 'CustomField');
    try {
      const child = await readFile(path.join(projection.snapshot.packageRoot, 'CustomField', 'Account.Rating__c.xml'), 'utf8');
      expect(child).toContain('<fullName>Rating__c</fullName>');
      expect(projection.snapshot.metadataTypes).toEqual([{ xmlName: 'CustomField', directoryName: 'CustomField', suffix: 'xml' }]);
    } finally {
      await projection.dispose();
    }
    await expect(sha256File(path.join(`${root}-left`, 'objects/Account.object'))).resolves.toBe(sourceParentSha256);
  });

  it('projects and compares a child value whose own XML exceeds 16MiB, including a final-byte change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-child-value-'));
    const largeValue = 'z'.repeat(CHILD_XML_SIZE_THRESHOLD + 1_024);
    const leftXml = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><fields><fullName>Large__c</fullName><description>${largeValue}A</description><type>Text</type></fields></CustomObject>`;
    const rightXml = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><fields><fullName>Large__c</fullName><description>${largeValue}B</description><type>Text</type></fields></CustomObject>`;
    expect(Buffer.byteLength(leftXml)).toBeGreaterThan(CHILD_XML_SIZE_THRESHOLD);
    const left = await snapshot(`${root}-left`, { 'objects/Account.object': leftXml });
    const right = await snapshot(`${root}-right`, { 'objects/Account.object': rightXml });
    roots.push(root, `${root}-left`, `${root}-right`);
    const before = await Promise.all([
      sha256File(path.join(`${root}-left`, 'objects/Account.object')),
      sha256File(path.join(`${root}-right`, 'objects/Account.object')),
    ]);

    const result = await compareSnapshots(left, right, { metadataType: 'CustomField' });
    const file = fileOf(result, 'CustomField:Account.Large__c');
    expect(file).toMatchObject({ status: 'MODIFIED', xmlSemanticStatus: 'DIFFERENT' });
    await expect(sha256File(path.join(`${root}-left`, 'objects/Account.object'))).resolves.toBe(before[0]);
    await expect(sha256File(path.join(`${root}-right`, 'objects/Account.object'))).resolves.toBe(before[1]);
  });

  it('cleans the temporary projection directory after malformed large XML', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-large-child-invalid-'));
    const malformed = `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><description>${'x'.repeat(CHILD_XML_SIZE_THRESHOLD + 1_024)}</description><fields><fullName>Broken__c</fullName>`;
    expect(Buffer.byteLength(malformed)).toBeGreaterThan(CHILD_XML_SIZE_THRESHOLD);
    const invalid = await snapshot(`${root}-invalid`, { 'objects/Account.object': malformed });
    roots.push(root, `${root}-invalid`);
    const removed = vi.mocked(fileSystem.rm);
    removed.mockClear();

    await expect(projectChildMetadata(invalid, 'CustomField')).rejects.toThrow();

    const projectionPaths = removed.mock.calls.map(([entry]) => entry).filter((entry): entry is string =>
      typeof entry === 'string' && path.basename(entry).startsWith('sfud-child-compare-'));
    expect(projectionPaths).toHaveLength(1);
    await expect(fileSystem.access(projectionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
