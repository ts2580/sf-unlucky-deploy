import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitMaterializer } from '../src/git/git-materializer.js';
import { GitObjectStore } from '../src/git/git-object-store.js';
import { runIsolatedGit } from '../src/git/git-process.js';
import { safeGitPath, selectedGitEntries } from '../src/git/git-project-validator.js';
import type { GitTreeEntry } from '../src/git/git-object-store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const config = JSON.stringify({ packageDirectories: [{ path: 'force-app' }, { path: 'extra' }], sourceApiVersion: '64.0' });
type Entry = { name: string; content?: string; mode?: string; objectId?: string };
async function fixture(entries: Entry[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-materializer-'));
  roots.push(root);
  const gitDirectory = path.join(root, 'objects.git');
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
  const git = (args: string[], input?: string) => {
    const result = spawnSync('git', [`--git-dir=${gitDirectory}`, ...args], {
      cwd: root, env, encoding: 'utf8', input, shell: false,
    });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  git(['init', '--bare']);
  const blobIds = new Map<string, string>();
  function tree(contents: Entry[]): string {
    const lines: string[] = [];
    const folders = new Map<string, Entry[]>();
    for (const entry of contents) {
      const slash = entry.name.indexOf('/');
      if (slash >= 0) {
        const name = entry.name.slice(0, slash);
        const list = folders.get(name) ?? [];
        list.push({ ...entry, name: entry.name.slice(slash + 1) });
        folders.set(name, list);
      } else {
        const mode = entry.mode ?? '100644';
        const content = entry.content ?? '';
        const objectId = entry.objectId ?? blobIds.get(content) ?? git(['hash-object', '-w', '--stdin'], content);
        if (entry.objectId === undefined) blobIds.set(content, objectId);
        lines.push(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${objectId}\t${entry.name}\0`);
      }
    }
    for (const [name, entries] of folders) lines.push(`040000 tree ${tree(entries)}\t${name}\0`);
    return git(['mktree', '-z', '--missing'], lines.join(''));
  }
  const commit = git(['commit-tree', tree(entries), '-m', 'test fixture']);
  const objects = new GitObjectStore(root, gitDirectory);
  return { root, gitDirectory, commit, git, objects, materializer: new GitMaterializer(objects) };
}
function project(prefix = ''): Entry[] {
  return [
    { name: `${prefix}sfdx-project.json`, content: config },
    { name: `${prefix}force-app/main/default/classes/Hello.cls`, content: 'public class Hello {}\r\n', mode: '100755' },
    { name: `${prefix}extra/classes/Extra.cls`, content: 'public class Extra {}\n' },
    { name: `${prefix}manifest/package.xml`, content: '<Package/>\n' },
    { name: `${prefix}.forceignore`, content: '**/ignored/**\n' },
  ];
}

describe('Git 원시 파일 추출', { timeout: 30_000 }, () => {
  it('기본 가져오기는 2,000개를 넘는 파일도 복원하여 배포 소스를 준비한다', async () => {
    const f = await fixture([{ name: 'sfdx-project.json', content: JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }) },
      ...Array.from({ length: 1000 }, (_, i) => [
        { name: `force-app/main/default/classes/Class${i}.cls`, content: 'public class Fixture {}' },
        { name: `force-app/main/default/classes/Class${i}.cls-meta.xml`, content: '<ApexClass/>' },
      ]).flat()]);
    const target = path.join(f.root, 'many-files');
    const result = await f.materializer.materialize(f.commit, '.', target, { metadataType: 'ApexClass' });
    expect(result.fileCount).toBe(2001);
    expect(await readFile(path.join(target, 'force-app/main/default/classes/Class999.cls'), 'utf8')).toBe('public class Fixture {}');
  });

  it('monorepo 루트를 선택하고 필터 실행 없이 원본 byte·여러 package·manifest를 보존한다', async () => {
    const f = await fixture([
      ...project('salesforce/'), ...project('other/'),
      { name: 'salesforce/.env.local', content: 'TOKEN=excluded' },
      { name: 'salesforce/private.pem', content: 'excluded' },
      { name: 'salesforce/node_modules/evil/index.js', content: 'excluded' },
      { name: 'salesforce/.sf/config.json', content: 'excluded' },
      { name: 'salesforce/.gitattributes', content: '*.cls filter=evil text eol=lf\n' },
      { name: 'salesforce/package.json', content: '{"scripts":{"postinstall":"exit 99"}}' },
    ]);
    f.git(['config', 'filter.evil.smudge', 'exit 99']);
    f.git(['config', 'filter.evil.required', 'true']);
    expect(await f.materializer.discover(f.commit)).toEqual(['other', 'salesforce']);
    const target = path.join(f.root, 'materialized');
    const result = await f.materializer.materialize(f.commit, 'salesforce', target);
    expect(result.manifests).toEqual(['manifest/package.xml']);
    expect(result.fileCount).toBe(7);
    expect(await readFile(path.join(target, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toBe('public class Hello {}\r\n');
    expect(await readFile(path.join(target, '.forceignore'), 'utf8')).toBe('**/ignored/**\n');
    for (const excluded of ['.env.local', '.sf', 'private.pem', 'node_modules', '.git']) {
      await expect(access(path.join(target, excluded))).rejects.toThrow();
    }
    const repeated = await f.materializer.materialize(f.commit, 'salesforce', path.join(f.root, 'repeated'));
    expect(repeated.checksum).toBe(result.checksum);
  });

  it.each([
    { name: 'force-app/link', mode: '120000', content: '/etc/passwd', code: 'UNSUPPORTED_SOURCE_FEATURE' },
    { name: 'force-app/submodule', mode: '160000', objectId: 'a'.repeat(40), code: 'UNSUPPORTED_SOURCE_FEATURE' },
    { name: 'force-app/lfs.cls', content: 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 42\n', code: 'UNSUPPORTED_SOURCE_FEATURE' },
    { name: 'force-app/CON.txt', content: 'invalid', code: 'UNSAFE_PROJECT_PATH' },
    { name: 'force-app/Hello.cls:stream', content: 'invalid', code: 'UNSAFE_PROJECT_PATH' },
  ])('위험한 소스 $name을 추출하지 않고 부분 디렉터리를 정리한다', async (entry) => {
    const f = await fixture([...project(), entry]);
    const target = path.join(f.root, 'materialized');
    await expect(f.materializer.materialize(f.commit, '.', target)).rejects.toMatchObject({ code: entry.code });
    await expect(access(target)).rejects.toThrow();
  });

  it('선택하지 않은 프로젝트의 symlink/submodule은 다운로드하거나 실행하지 않는다', async () => {
    const f = await fixture([...project('selected/'), { name: 'elsewhere/link', mode: '120000', content: '/etc' }]);
    await expect(f.materializer.materialize(f.commit, 'selected', path.join(f.root, 'materialized'))).resolves.toMatchObject({ fileCount: 5 });
  });

  it.each(['../outside', '/outside', 'C:/outside', 'force-app/../extra', '.sf'])('packageDirectories의 %s 경로를 거절한다', async (directory) => {
    const entries = project();
    entries[0]!.content = JSON.stringify({ packageDirectories: [{ path: 'force-app' }, { path: directory }] });
    const f = await fixture(entries);
    await expect(f.materializer.materialize(f.commit, '.', path.join(f.root, 'materialized'))).rejects.toMatchObject({ code: 'UNSAFE_PROJECT_PATH' });
  });

  it('디렉터리 대소문자·Unicode 정규화 충돌 및 중복 파일을 거절한다', () => {
    const entry = (name: string): GitTreeEntry => ({ path: name, type: 'blob', mode: '100644', objectId: 'a'.repeat(40), size: 0 });
    for (const names of [['force-app/a', 'FORCE-APP/b'], ['a/é', 'a/e\u0301'], ['file', 'file'], ['file', 'file/nested']]) {
      expect(() => selectedGitEntries(names.map(entry), '.')).toThrow();
    }
    for (const value of ['a/../b', 'a\\b', 'a/NUL', 'a/COM¹.txt', 'a/trailing.', 'a/trailing ', 'a/GIT~1']) {
      expect(() => safeGitPath(value)).toThrow();
    }
  });

  it('용량·파일 수·취소를 검사하고 기존 출력 디렉터리를 덮어쓰지 않는다', async () => {
    const f = await fixture(project());
    for (const options of [{ maximumFiles: 1 }, { maximumProjectBytes: 20 }, { maximumFileBytes: 10 }]) {
      await expect(f.materializer.materialize(f.commit, '.', path.join(f.root, 'limit'), options)).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
    }
    const controller = new AbortController();
    await expect(f.materializer.materialize(f.commit, '.', path.join(f.root, 'cancelled'), {
      signal: controller.signal, onBytes: () => controller.abort(),
    })).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' });
    await expect(access(path.join(f.root, 'cancelled'))).rejects.toThrow();
    const occupied = path.join(f.root, 'occupied');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'keep'), 'existing');
    await expect(f.materializer.materialize(f.commit, '.', occupied)).rejects.toThrow();
    expect(await readFile(path.join(occupied, 'keep'), 'utf8')).toBe('existing');
  });

  it('Git 환경 설정·전역 credential·secret 환경을 상속하지 않으며 blob 한도를 적용한다', async () => {
    const f = await fixture(project());
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'alias.dangerous');
    vi.stubEnv('GIT_CONFIG_VALUE_0', '!exit 99');
    vi.stubEnv('GIT_DIR', '/nonexistent');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(f.root, 'hostile-config'));
    await writeFile(path.join(f.root, 'hostile-config'), '[include]\npath = /nonexistent\n[alias]\ndangerous = !exit 99\n');
    expect((await f.objects.listTree(f.commit)).length).toBe(5);
    await expect(runIsolatedGit(['config', '--get', 'alias.dangerous'], { cwd: f.root, gitDirectory: f.gitDirectory })).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
    const blob = (await f.objects.listTree(f.commit)).find((entry) => entry.path === 'sfdx-project.json')!;
    await expect(f.objects.readBlob(blob.objectId, 2)).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
    await expect(f.objects.listTree(f.commit, AbortSignal.abort())).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' });
    await expect(runIsolatedGit(['rev-parse', '--git-dir'], {
      cwd: f.root, gitDirectory: f.gitDirectory,
      onDiskUsage: () => { throw new Error('quota'); },
    })).rejects.toThrow();
    expect((await readdir(f.root)).includes('materialized')).toBe(false);
  });
});
