import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCompareCommand } from '../src/commands/compare.js';
import { projectChildMetadata } from '../src/metadata/child-metadata-projection.js';
import { compareSnapshots } from '../src/metadata/comparator.js';
import { sha256Directory, sha256File } from '../src/core/files.js';
import type { MetadataSnapshot } from '../src/sources/snapshot.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
const hasSalesforceCli = spawnSync('sf', ['--version'], { stdio: 'ignore' }).status === 0;
const manifest = '<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>64.0</version></Package>\n';

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mdapiSnapshot(root: string, objectXml: string, labelsXml?: string): Promise<MetadataSnapshot> {
  await mkdir(path.join(root, 'objects'), { recursive: true });
  const manifestPath = path.join(root, 'package.xml');
  await writeFile(manifestPath, manifest);
  await writeFile(path.join(root, 'objects', 'Account.object'), objectXml);
  if (labelsXml !== undefined) {
    await mkdir(path.join(root, 'labels'), { recursive: true });
    await writeFile(path.join(root, 'labels', 'CustomLabels.labels'), labelsXml);
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

function objectXml(fields: string): string {
  return `<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label>${fields}</CustomObject>`;
}

function fieldXml(fullName: string, label: string, type = 'Text'): string {
  return `<fields><fullName>${fullName}</fullName><label>${label}</label><type>${type}</type></fields>`;
}

describe('child metadata comparison projection', { timeout: 60_000 }, () => {
  it('CustomField를 field component으로 분리해 modified/identical/added/removed를 구분하고 원본을 보존한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-comparison-'));
    roots.push(root);
    const left = await mdapiSnapshot(root + '-left', objectXml([
      fieldXml('Changed__c', 'A &amp; B'),
      fieldXml('Same__c', 'Same'),
      fieldXml('Removed__c', 'Removed'),
    ].join('')));
    const right = await mdapiSnapshot(root + '-right', objectXml([
      fieldXml('Changed__c', 'A &amp; C'),
      fieldXml('Same__c', 'Same'),
      fieldXml('Added__c', 'Added'),
    ].join('')));
    roots.push(root + '-left', root + '-right');
    const before = await Promise.all([
      sha256Directory(left.packageRoot),
      sha256Directory(right.packageRoot),
      readFile(path.join(left.packageRoot, 'objects', 'Account.object'), 'utf8'),
      readFile(path.join(right.packageRoot, 'objects', 'Account.object'), 'utf8'),
    ]);

    const result = await compareSnapshots(left, right, { metadataType: 'CustomField' });
    const components = new Map(result.components.map((component) => [component.key, component]));
    expect(result.summary).toMatchObject({ modified: 1, identical: 1, added: 1, removed: 1, total: 4, different: 3 });
    expect(components.get('CustomField:Account.Changed__c')).toMatchObject({ type: 'CustomField', fullName: 'Account.Changed__c', status: 'MODIFIED' });
    expect(components.get('CustomField:Account.Same__c')).toMatchObject({ type: 'CustomField', fullName: 'Account.Same__c', status: 'IDENTICAL' });
    expect(components.get('CustomField:Account.Added__c')).toMatchObject({ type: 'CustomField', fullName: 'Account.Added__c', status: 'ADDED' });
    expect(components.get('CustomField:Account.Removed__c')).toMatchObject({ type: 'CustomField', fullName: 'Account.Removed__c', status: 'REMOVED' });
    const changed = components.get('CustomField:Account.Changed__c')!;
    expect(changed.files.flatMap((file) => file.xmlChanges ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: 'A & B', after: 'A & C' }),
    ]));

    expect(await sha256Directory(left.packageRoot)).toBe(before[0]);
    expect(await sha256Directory(right.packageRoot)).toBe(before[1]);
    await expect(readFile(path.join(left.packageRoot, 'objects', 'Account.object'), 'utf8')).resolves.toBe(before[2]);
    await expect(readFile(path.join(right.packageRoot, 'objects', 'Account.object'), 'utf8')).resolves.toBe(before[3]);
  });

  it('CustomLabel은 parent 이름을 fullName에 붙이지 않고 XML entity를 해석한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-label-'));
    roots.push(root);
    const labels = '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Welcome</fullName><value>Hello &amp; welcome</value><protected>false</protected></labels><labels><fullName>Same</fullName><value>Same</value></labels></CustomLabels>';
    const left = await mdapiSnapshot(path.join(root, 'left'), objectXml(''), labels);
    const right = await mdapiSnapshot(path.join(root, 'right'), objectXml(''), '<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Welcome</fullName><value>Hello &amp; world</value><protected>false</protected></labels><labels><fullName>Same</fullName><value>Same</value></labels></CustomLabels>');
    const result = await compareSnapshots(left, right, { metadataType: 'CustomLabel' });
    const keys = result.components.map((component) => component.key).sort();
    expect(keys).toEqual(['CustomLabel:Same', 'CustomLabel:Welcome']);
    expect(result.components.find((component) => component.key === 'CustomLabel:Welcome')).toMatchObject({ type: 'CustomLabel', fullName: 'Welcome', status: 'MODIFIED' });
    expect(result.components.find((component) => component.key === 'CustomLabel:Welcome')?.files.flatMap((file) => file.xmlChanges ?? [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: 'Hello & welcome', after: 'Hello & world' }),
    ]));
  });

  it('하위 metadata XML 오류 뒤 projection 임시 디렉터리를 정리한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-cleanup-'));
    roots.push(root);
    const snapshot = await mdapiSnapshot(path.join(root, 'invalid'), '<CustomObject><fields>');
    const removed = vi.mocked(fileSystem.rm);
    removed.mockClear();
    await expect(projectChildMetadata(snapshot, 'CustomField')).rejects.toThrow();
    const projectionPaths = removed.mock.calls.map(([entry]) => entry).filter((entry): entry is string =>
      typeof entry === 'string' && path.basename(entry).startsWith('sfud-child-compare-'));
    expect(projectionPaths).toHaveLength(1);
    await expect(fileSystem.access(projectionPaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!hasSalesforceCli)('실제 sf source-only CustomField 비교도 CustomField component를 반환한다', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-cli-'));
    roots.push(root);
    const project = path.join(root, 'project');
    const objectRoot = path.join(project, 'force-app', 'main', 'default', 'objects', 'Account');
    await mkdir(path.join(objectRoot, 'fields'), { recursive: true });
    await writeFile(path.join(project, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '64.0' }));
    await writeFile(path.join(objectRoot, 'Account.object-meta.xml'), '<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata"><label>Account</label></CustomObject>');
    await writeFile(path.join(objectRoot, 'fields', 'Rating__c.field-meta.xml'), '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>Rating__c</fullName><label>Rating</label><type>Text</type></CustomField>');

    const result = await runCompareCommand({
      left: `local:${project}`,
      right: `local:${project}`,
      sourceOnly: true,
      metadataType: 'CustomField',
      reportDir: path.join(root, 'reports'),
      color: false,
    }, { cwd: root, stdout: () => undefined });
    expect(result.comparison.components.map((component) => component.key)).toContain('CustomField:Account.Rating__c');
    expect(result.comparison.components.some((component) => component.type === 'CustomObject')).toBe(false);
  });
});
