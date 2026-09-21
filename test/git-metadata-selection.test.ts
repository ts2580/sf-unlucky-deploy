import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceSource } from '../src/api/workspace-contracts.js';
import { GitMaterializer } from '../src/git/git-materializer.js';
import { GitObjectStore, type GitObjectReader, type GitTreeEntry } from '../src/git/git-object-store.js';
import { assertGitMetadataScope } from '../src/sources/git-metadata-scope.js';

type FixtureEntry = { path: string; content: string; mode?: string };

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const projectJson = JSON.stringify({
  packageDirectories: [{ path: 'force-app' }, { path: 'extra' }],
  sourceApiVersion: '64.0',
});

function gitFixture(entries: readonly FixtureEntry[]) {
  return mkdtemp(path.join(os.tmpdir(), 'sfud-git-metadata-selection-')).then(async (root) => {
    roots.push(root);
    const gitDirectory = path.join(root, 'objects.git');
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    };
    const git = (args: readonly string[], input?: string): string => {
      const result = spawnSync('git', [`--git-dir=${gitDirectory}`, ...args], {
        cwd: root,
        env,
        encoding: 'utf8',
        input,
        shell: false,
      });
      if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      return result.stdout.trim();
    };
    git(['init', '--bare']);

    const tree = (contents: readonly FixtureEntry[]): string => {
      const files: string[] = [];
      const folders = new Map<string, FixtureEntry[]>();
      for (const entry of contents) {
        const slash = entry.path.indexOf('/');
        if (slash >= 0) {
          const name = entry.path.slice(0, slash);
          const folder = folders.get(name) ?? [];
          folder.push({ ...entry, path: entry.path.slice(slash + 1) });
          folders.set(name, folder);
        } else {
          const mode = entry.mode ?? '100644';
          const type = mode === '160000' ? 'commit' : 'blob';
          const objectId = mode === '160000' ? 'a'.repeat(40) : git(['hash-object', '-w', '--stdin'], entry.content);
          files.push(`${mode} ${type} ${objectId}\t${entry.path}\0`);
        }
      }
      for (const [name, folder] of folders) files.push(`040000 tree ${tree(folder)}\t${name}\0`);
      return git(['mktree', '-z', '--missing'], files.join(''));
    };

    const commit = git(['commit-tree', tree(entries), '-m', 'metadata selection fixture']);
    const objects = new GitObjectStore(root, gitDirectory);
    return { root, commit, objects };
  });
}

class TracingReader implements GitObjectReader {
  public readonly reads: string[] = [];
  public readonly prepared: string[] = [];

  public constructor(private readonly delegate: GitObjectReader, private readonly partialSizes = false) {}

  public async listTree(commit: string, signal?: AbortSignal): Promise<GitTreeEntry[]> {
    const entries = await this.delegate.listTree(commit, signal);
    return this.partialSizes
      ? entries.map((entry) => entry.type === 'blob' ? { ...entry, size: -1 } : entry)
      : entries;
  }

  public async readBlob(objectId: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
    this.reads.push(objectId);
    return this.delegate.readBlob(objectId, maximumBytes, signal);
  }

  public async prepareBlobs(objectIds: readonly string[], _signal?: AbortSignal): Promise<void> {
    this.prepared.push(...objectIds);
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath, entryRelative);
      else output.push(entryRelative);
    }
  };
  await visit(root, '');
  return output.sort();
}

function entriesForProject(prefix = ''): FixtureEntry[] {
  return [
    { path: `${prefix}sfdx-project.json`, content: projectJson },
    { path: `${prefix}.forceignore`, content: '**/ignored/**\n' },
    { path: `${prefix}config/project-scratch-def.json`, content: '{"orgName":"fixture"}\n' },
    { path: `${prefix}manifest/package.xml`, content: '<Package/>\n' },
    { path: `${prefix}extra/README.md`, content: 'package marker\n' },
  ];
}

describe('Git Salesforce metadata 선택 materialization', { timeout: 30_000 }, () => {
  it('root와 여러 package directory에서 ApexClass와 companion meta만 읽고 공통 설정을 유지한다', async () => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/classes/Keep.cls', content: 'public class Keep {}\n' },
      { path: 'force-app/main/default/classes/Keep.cls-meta.xml', content: '<ApexClass/>\n' },
      { path: 'force-app/main/default/classes/Drop.cls', content: 'public class Drop {}\n' },
      { path: 'force-app/main/default/classes/Drop.cls-meta.xml', content: '<ApexClass/>\n' },
      { path: 'extra/main/default/classes/Other.cls', content: 'public class Other {}\n' },
      { path: 'extra/main/default/classes/Other.cls-meta.xml', content: '<ApexClass/>\n' },
      { path: 'force-app/main/default/triggers/Unrelated.trigger', content: 'trigger Unrelated on Account (before insert) {}\n' },
      { path: 'force-app/main/default/triggers/Unrelated.trigger-meta.xml', content: '<ApexTrigger/>\n' },
      { path: 'force-app/main/default/customMetadata/Unrelated.md-meta.xml', content: '<CustomMetadata/>\n' },
    ]);
    const reader = new TracingReader(fixture.objects);
    const result = await new GitMaterializer(reader).materialize(fixture.commit, '.', path.join(fixture.root, 'materialized'), {
      metadataType: 'ApexClass',
    });
    const target = path.join(fixture.root, 'materialized');

    expect(result.fileCount).toBe(8);
    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      'extra/main/default/classes/Other.cls',
      'extra/main/default/classes/Other.cls-meta.xml',
      'force-app/main/default/classes/Keep.cls',
      'force-app/main/default/classes/Keep.cls-meta.xml',
      'force-app/main/default/classes/Drop.cls',
      'force-app/main/default/classes/Drop.cls-meta.xml',
      'sfdx-project.json',
    ].sort());
    expect(await readFile(path.join(target, 'force-app/main/default/classes/Keep.cls'), 'utf8')).toBe('public class Keep {}\n');
    expect(await readFile(path.join(target, '.forceignore'), 'utf8')).toBe('**/ignored/**\n');
    expect(await readFile(path.join(target, 'sfdx-project.json'), 'utf8')).toBe(projectJson);

    const tree = await fixture.objects.listTree(fixture.commit);
    const unrelated = tree.filter((entry) => /(?:Unrelated|customMetadata)/u.test(entry.path));
    expect(unrelated).not.toHaveLength(0);
    for (const entry of unrelated) {
      expect(reader.reads).not.toContain(entry.objectId);
      expect(reader.prepared).not.toContain(entry.objectId);
    }
  });

  it('monorepo에서는 선택한 Salesforce project root만 대상으로 삼는다', async () => {
    const fixture = await gitFixture([
      ...entriesForProject('salesforce/'),
      { path: 'salesforce/force-app/main/default/classes/Keep.cls', content: 'public class Keep {}\n' },
      { path: 'salesforce/force-app/main/default/classes/Keep.cls-meta.xml', content: '<ApexClass/>\n' },
      { path: 'salesforce/force-app/main/default/classes/Drop.cls', content: 'public class Drop {}\n' },
      { path: 'salesforce/force-app/main/default/classes/Drop.cls-meta.xml', content: '<ApexClass/>\n' },
      ...entriesForProject('other/'),
      { path: 'other/force-app/main/default/classes/Outside.cls', content: 'public class Outside {}\n' },
      { path: 'other/force-app/main/default/classes/Outside.cls-meta.xml', content: '<ApexClass/>\n' },
    ]);
    const reader = new TracingReader(fixture.objects);
    const target = path.join(fixture.root, 'materialized');
    await new GitMaterializer(reader).materialize(fixture.commit, 'salesforce', target, { metadataType: 'ApexClass' });
    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      'force-app/main/default/classes/Drop.cls',
      'force-app/main/default/classes/Drop.cls-meta.xml',
      'force-app/main/default/classes/Keep.cls',
      'force-app/main/default/classes/Keep.cls-meta.xml',
      'sfdx-project.json',
    ]);
    expect((await filesUnder(fixture.root)).some((entry) => entry.includes('Outside'))).toBe(false);
  });

  it('선택 타입 밖의 symlink/submodule은 무시하고 선택 blob만 prepare한다', async () => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/classes/Keep.cls', content: 'public class Keep {}\n' },
      { path: 'force-app/main/default/classes/Keep.cls-meta.xml', content: '<ApexClass/>\n' },
      { path: 'force-app/main/default/triggers/unsafe.trigger', mode: '120000', content: '/etc/passwd' },
      { path: 'extra/main/default/triggers/unsafe.trigger', mode: '160000', content: '' },
    ]);
    const reader = new TracingReader(fixture.objects);
    const target = path.join(fixture.root, 'materialized');
    await new GitMaterializer(reader).materialize(fixture.commit, '.', target, { metadataType: 'ApexClass' });

    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      'force-app/main/default/classes/Keep.cls',
      'force-app/main/default/classes/Keep.cls-meta.xml',
      'sfdx-project.json',
    ]);
    const tree = await fixture.objects.listTree(fixture.commit);
    for (const entry of tree.filter((candidate) => candidate.path.includes('unsafe.trigger'))) {
      expect(reader.prepared).not.toContain(entry.objectId);
      expect(reader.reads).not.toContain(entry.objectId);
    }
  });

  it.each(['120000', '160000'] as const)('선택 타입 폴더의 %s는 prepareBlobs 전에 거절한다', async (mode) => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/classes/Unsafe.cls', mode, content: mode === '120000' ? '/etc/passwd' : '' },
    ]);
    const reader = new TracingReader(fixture.objects);
    await expect(new GitMaterializer(reader).materialize(
      fixture.commit,
      '.',
      path.join(fixture.root, 'materialized'),
      { metadataType: 'ApexClass' },
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_SOURCE_FEATURE' });
    expect(reader.prepared).toEqual([]);
  });

  it('CustomField는 objects 아래 fields와 object-meta.xml만 남기고 validationRules는 제외한다', async () => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/objects/Account/Account.object-meta.xml', content: '<CustomObject/>\n' },
      { path: 'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml', content: '<CustomField/>\n' },
      { path: 'force-app/main/default/objects/Account/fields/Region__c.field-meta.xml', content: '<CustomField/>\n' },
      { path: 'force-app/main/default/objects/Account/validationRules/Required.validationRule-meta.xml', content: '<ValidationRule/>\n' },
      { path: 'force-app/main/default/objects/Account/listViews/Recent.listView-meta.xml', content: '<ListView/>\n' },
      { path: 'force-app/main/default/objects/Contact/Contact.object-meta.xml', content: '<CustomObject/>\n' },
      { path: 'force-app/main/default/objects/Contact/fields/Status__c.field-meta.xml', content: '<CustomField/>\n' },
      { path: 'force-app/main/default/classes/Outside.cls', content: 'public class Outside {}\n' },
    ]);
    const target = path.join(fixture.root, 'materialized');
    await new GitMaterializer(new TracingReader(fixture.objects)).materialize(fixture.commit, '.', target, {
      metadataType: 'CustomField',
    });

    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      'force-app/main/default/objects/Account/fields/Rating__c.field-meta.xml',
      'force-app/main/default/objects/Account/fields/Region__c.field-meta.xml',
      'force-app/main/default/objects/Account/Account.object-meta.xml',
      'force-app/main/default/objects/Contact/fields/Status__c.field-meta.xml',
      'force-app/main/default/objects/Contact/Contact.object-meta.xml',
      'sfdx-project.json',
    ].sort());
    await expect(access(path.join(target, 'force-app/main/default/objects/Account/validationRules'))).rejects.toThrow();
  });

  it.each([
    ['LightningComponentBundle', 'lwc', 'Widget', ['Widget.js', 'Widget.html', 'Widget.js-meta.xml']],
    ['AuraDefinitionBundle', 'aura', 'Widget', ['Widget.cmp', 'WidgetController.js', 'Widget.cmp-meta.xml']],
  ] as const)('%s 선택은 bundle 전체와 bundle 하나만 유지한다', async (metadataType, directory, selected, selectedFiles) => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      ...selectedFiles.map((file) => ({ path: `force-app/main/default/${directory}/${selected}/${file}`, content: `fixture ${file}\n` })),
      ...(['Widget2.js', 'Widget2.html', 'Widget2.js-meta.xml'].map((file) => ({
        path: `force-app/main/default/${directory}/Widget2/${file}`,
        content: `other ${file}\n`,
      }))),
    ]);
    const target = path.join(fixture.root, 'materialized');
    await new GitMaterializer(new TracingReader(fixture.objects)).materialize(fixture.commit, '.', target, { metadataType });

    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      ...selectedFiles.map((file) => `force-app/main/default/${directory}/${selected}/${file}`),
      'force-app/main/default/' + directory + '/Widget2/Widget2.html',
      'force-app/main/default/' + directory + '/Widget2/Widget2.js',
      'force-app/main/default/' + directory + '/Widget2/Widget2.js-meta.xml',
      'sfdx-project.json',
    ].sort());
  });

  it('선택된 type이 없어도 빈 package directory를 만들고 unknown type은 거절한다', async () => {
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/README.md', content: 'no metadata here\n' },
      { path: 'extra/main/default/README.md', content: 'no metadata here\n' },
    ]);
    const target = path.join(fixture.root, 'empty');
    await new GitMaterializer(new TracingReader(fixture.objects)).materialize(fixture.commit, '.', target, {
      metadataType: 'ApexClass',
    });
    expect(await filesUnder(target)).toEqual([
      '.forceignore',
      'sfdx-project.json',
    ]);
    await expect(stat(path.join(target, 'force-app'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(stat(path.join(target, 'extra'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    await expect(new GitMaterializer(new TracingReader(fixture.objects)).materialize(
      fixture.commit,
      '.',
      path.join(fixture.root, 'unknown'),
      { metadataType: 'NotASalesforceMetadataType' },
    )).rejects.toThrow();
  });

  it('partial tree entry size=-1이어도 실제 bytes로 project quota를 계산한다', async () => {
    const keep = 'public class Keep {}\n';
    const keepMeta = '<ApexClass/>\n';
    const ignore = '**/ignored/**\n';
    const fixture = await gitFixture([
      ...entriesForProject(),
      { path: 'force-app/main/default/classes/Keep.cls', content: keep },
      { path: 'force-app/main/default/classes/Keep.cls-meta.xml', content: keepMeta },
      { path: 'force-app/main/default/classes/Drop.cls', content: 'public class Drop {}\n' },
      { path: 'force-app/main/default/classes/Drop.cls-meta.xml', content: '<ApexClass/>\n' },
    ]);
    const selectedBytes = Buffer.byteLength(projectJson) + Buffer.byteLength(ignore)
      + Buffer.byteLength(keep) + Buffer.byteLength(keepMeta);
    const drop = 'public class Drop {}\n';
    const dropMeta = '<ApexClass/>\n';
    const allSelectedBytes = selectedBytes + Buffer.byteLength(drop) + Buffer.byteLength(dropMeta);
    const target = path.join(fixture.root, 'partial');
    const reader = new TracingReader(fixture.objects, true);
    const result = await new GitMaterializer(reader).materialize(fixture.commit, '.', target, {
      metadataType: 'ApexClass',
      maximumProjectBytes: allSelectedBytes,
    });
    expect(result.sizeBytes).toBe(allSelectedBytes);
    await expect(new GitMaterializer(new TracingReader(fixture.objects, true)).materialize(
      fixture.commit,
      '.',
      path.join(fixture.root, 'partial-too-small'),
      { metadataType: 'ApexClass', maximumProjectBytes: allSelectedBytes - 1 },
    )).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
  });

  it('metadata scoped Git source는 같은 type 요청만 허용한다', () => {
    const source = {
      id: 'git:fixture',
      kind: 'local',
      location: 'git',
      label: 'fixture',
      provenance: {
        provider: 'github',
        host: 'github.com',
        repositoryId: 'fixture',
        repositoryPath: 'owner/repo',
        refType: 'branch',
        refName: 'main',
        commitSha: 'a'.repeat(40),
        projectRoot: '.',
        metadataType: 'ApexClass',
        importedAt: new Date(0).toISOString(),
        importedContentChecksum: 'b'.repeat(64),
        sourceOwnerUserId: 'owner',
        importId: 'fixture',
      },
    } satisfies WorkspaceSource;

    expect(() => assertGitMetadataScope(source, ['ApexClass'])).not.toThrow();
    expect(() => assertGitMetadataScope(source, ['ApexClass', 'CustomField'])).toThrow();
    expect(() => assertGitMetadataScope(source, undefined)).toThrow();
    const unscopedSource: WorkspaceSource = {
      id: source.id,
      kind: source.kind,
      location: source.location,
      label: source.label,
    };
    expect(() => assertGitMetadataScope(unscopedSource, ['CustomField'])).not.toThrow();
  });
});
