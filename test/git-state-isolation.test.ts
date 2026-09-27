import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { GitCache } from '../src/git/git-cache.js';
import { GitImportService } from '../src/git/git-import-service.js';
import { GitRegistrationService } from '../src/git/git-registration-service.js';
import { GitImportRepository } from '../src/storage/git-import-repository.js';
import { GitObjectStore } from '../src/git/git-object-store.js';
import { GitMaterializer } from '../src/git/git-materializer.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import type { GitProvider } from '../src/git/git-provider.js';
import type { GitFetchOptions } from '../src/git/git-client.js';
import { createWebRuntime } from '../src/web/server/runtime.js';
import { SingleJobQueue } from '../src/deploy/single-job-queue.js';
import type { SfClient } from '../src/salesforce/sf-client.js';
import { writeFixtureFiles } from './support/files.js';
import { GitError } from '../src/git/git-errors.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-state-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false,
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
async function fixture() {
  const root = await temporary();
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'force-app/main/default/classes'), { recursive: true });
  await mkdir(path.join(source, 'force-app/main/default/triggers'), { recursive: true });
  await writeFile(path.join(source, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app' }], sourceApiVersion: '64.0' }));
  await writeFile(path.join(source, 'force-app/main/default/classes/Hello.cls'), 'public class Hello { /* first */ }\r\n');
  await writeFile(path.join(source, 'force-app/main/default/classes/Hello.cls-meta.xml'), '<ApexClass/>');
  await writeFile(path.join(source, 'force-app/main/default/triggers/Other.trigger'), 'trigger Other on Account (before insert) {}');
  git(source, ['init', '-b', 'main']);
  const commit = () => { git(source, ['add', '.']); git(source, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); return git(source, ['rev-parse', 'HEAD']); };
  const first = commit();
  const databasePath = path.join(root, 'runtime', 'sfud.db');
  const sfClient: SfClient = { async runJson(args, options) {
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    const manifest = '<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>Hello</members><name>ApexClass</name></types><version>64.0</version></Package>';
    if (args.includes('convert')) {
      await writeFixtureFiles(flag('--output-dir'), { 'package.xml': manifest,
        'classes/Hello.cls': await readFile(path.join(options!.cwd!, 'force-app/main/default/classes/Hello.cls'), 'utf8'),
        'classes/Hello.cls-meta.xml': '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>64.0</apiVersion><status>Active</status></ApexClass>' });
      return { status: 0 };
    }
    if (args.includes('generate') && args.includes('manifest')) {
      await writeFile(path.join(flag('--output-dir'), flag('--name')), manifest);
      return { status: 0 };
    }
    return { result: { nonScratchOrgs: [] } };
  } };
  let runtime = await createWebRuntime(databasePath, 'bootstrap', [], root, sfClient);
  const owner = await runtime.auth.bootstrapAdmin({ bootstrapToken: 'bootstrap', email: 'owner@example.com', displayName: 'owner', password: 'fixture-password-long' });
  const cachePath = path.join(root, 'injected', 'sfud.db');
  let cache = await GitCache.create(cachePath);
  const provider: GitProvider = { id: 'github',
    inspect: vi.fn(async () => ({ ...normalizeRepository('owner/project', 'github'), repositoryId: 'stable-id', private: false })),
    resolveCommit: vi.fn(async () => git(source, ['rev-parse', 'refs/heads/main'])), listRefs: vi.fn(async () => ({ refs: [] })),
  };
  const directories: string[] = [];
  const fetch = vi.fn(async (options: GitFetchOptions) => {
    directories.push(options.directory);
    const gitDirectory = path.join(options.directory, 'repository.git');
    git(root, ['init', '--bare', gitDirectory]);
    git(root, [`--git-dir=${gitDirectory}`, 'fetch', '--no-tags', '--', source, '+refs/heads/main:refs/remotes/origin/selected']);
    if (git(root, [`--git-dir=${gitDirectory}`, 'rev-parse', 'refs/remotes/origin/selected']) !== options.commitSha) throw new GitError('REF_CHANGED');
    return new GitObjectStore(options.directory, gitDirectory);
  });
  const configure = () => {
    const imports = new GitImportService(new GitImportRepository(runtime.store.database), runtime.workspace.managedProjects,
      { cache, providers: { github: provider, gitlab: provider, bitbucket: provider }, client: { fetch } });
    const registrations = new GitRegistrationService(runtime.store.database, imports);
    runtime.gitImports = imports; runtime.workspace.gitImports = imports;
    runtime.gitRegistrations = registrations; runtime.workspace.gitRegistrations = registrations;
    return { imports, registrations };
  };
  let services = configure();
  const restart = async () => {
    await services.imports.close(); await cache.close(); await runtime.shutdown();
    runtime = await createWebRuntime(databasePath, undefined, [], root, sfClient);
    cache = await GitCache.create(cachePath); services = configure();
  };
  cleanups.push(async () => { await services.imports.close(); await cache.close(); await runtime.shutdown(); });
  return { root, source, first, commit, owner: owner.user.id, provider, fetch, directories, restart,
    get runtime() { return runtime; }, get imports() { return services.imports; }, get registrations() { return services.registrations; },
    request: { provider: 'github' as const, repositoryPath: 'owner/project', ref: { kind: 'branch' as const, name: 'main' }, expectedCommitSha: first, projectRoot: '.' } };
}

describe('영속 Git 상태와 작업별 restore', { timeout: 30_000 }, () => {
  it('등록·자동 최신화·타입별 restore·동일 세션 작업 격리·재시작 캐시 재사용', async () => {
    const f = await fixture();
    const registered = await f.registrations.register(f.owner, f.request);
    expect(registered.lastCommitSha).toBe(f.first);
    expect(f.imports.listSources(f.owner)).toEqual([]); // Warm-up did not materialize classes.
    const a = await f.registrations.prepare(registered.id, f.owner, 'ApexClass', { sessionId: 'session-one', jobId: 'job-a', side: 'right' });
    const oldPath = f.imports.resolve(a.id, f.owner).realPath;
    expect(oldPath).toContain(path.join('session-one', 'job-a', 'right'));
    await expect(access(path.join(oldPath, 'force-app/main/default/triggers/Other.trigger'))).rejects.toThrow();
    const original = await readFile(path.join(oldPath, 'force-app/main/default/classes/Hello.cls'), 'utf8');
    await writeFile(path.join(f.source, 'force-app/main/default/classes/Hello.cls'), 'public class Hello { /* second */ }\n');
    const second = f.commit();
    const [b, c] = await Promise.all([
      f.registrations.prepare(registered.id, f.owner, 'ApexClass', { sessionId: 'session-one', jobId: 'job-b', side: 'right' }),
      f.registrations.prepare(registered.id, f.owner, 'ApexTrigger', { sessionId: 'session-two', jobId: 'job-c', side: 'left' }),
    ]);
    expect(b.expectedCommitSha).toBe(second); expect(c.expectedCommitSha).toBe(second);
    expect(await readFile(path.join(oldPath, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toBe(original);
    expect(await readFile(path.join(f.imports.resolve(b.id, f.owner).realPath, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toContain('second');
    await expect(access(path.join(f.imports.resolve(c.id, f.owner).realPath, 'force-app/main/default/classes/Hello.cls'))).rejects.toThrow();
    expect(new Set(f.directories).size).toBe(1);
    const objectsBefore = git(f.root, [`--git-dir=${path.join(f.directories[0]!, 'repository.git')}`, 'count-objects', '-v']);
    await f.restart();
    expect((await f.registrations.get(registered.id, f.owner)).lastCommitSha).toBe(second);
    await f.registrations.sync(registered.id, f.owner);
    expect(new Set(f.directories).size).toBe(1);
    expect(git(f.root, [`--git-dir=${path.join(f.directories[0]!, 'repository.git')}`, 'count-objects', '-v'])).toBe(objectsBefore);
  });

  it('등록 소스의 비교 생성에서 최신 SHA와 세션/비교 ID를 연결하고 완료 payload를 고정한다', async () => {
    const f = await fixture();
    const registered = await f.registrations.register(f.owner, f.request);
    const sourceId = `git-registered:${registered.id}`;
    const input = { scope: 'all' as const, metadataType: 'ApexClass', leftSourceId: sourceId, rightSourceId: sourceId,
      sourceOnly: true, strict: false, showIdentical: false, createdBy: f.owner, sessionWorkspaceId: 'same-session' };
    const first = await f.runtime.comparisons.create(input);
    await f.runtime.comparisonQueue.onIdle();
    const completed = await f.runtime.comparisonJobs.getRequired(first.id);
    expect(completed.status).toBe('SUCCEEDED');
    expect(completed.sourceSnapshot?.right?.provenance?.commitSha).toBe(f.first);
    expect(completed.rightSource).toContain(path.join('same-session', first.id, 'right'));
    const snapshot = JSON.parse(await readFile(path.join(completed.runDirectory!, 'right/snapshot.json'), 'utf8')) as { packageRoot: string; payloadSha256: string };
    const content = await readFile(path.join(snapshot.packageRoot, 'classes/Hello.cls'), 'utf8');
    await writeFile(path.join(f.source, 'force-app/main/default/classes/Hello.cls'), 'public class Hello { /* changed after comparison */ }');
    const next = f.commit();
    const second = await f.runtime.comparisons.create(input);
    await f.runtime.comparisonQueue.onIdle();
    expect((await f.runtime.comparisonJobs.getRequired(second.id)).sourceSnapshot?.right?.provenance?.commitSha).toBe(next);
    expect(first.rightSource).not.toBe(second.rightSource);
    expect(await readFile(path.join(snapshot.packageRoot, 'classes/Hello.cls'), 'utf8')).toBe(content);
    await f.restart();
    expect((await f.runtime.comparisonJobs.getRequired(first.id)).status).toBe('SUCCEEDED');
    expect(await readFile(path.join(snapshot.packageRoot, 'classes/Hello.cls'), 'utf8')).toBe(content);
  });

  it('fetch 실패 시 이전 SHA로 비교하지 않고 사용자 인가 및 마지막 성공 기록을 유지한다', async () => {
    const f = await fixture();
    const registration = await f.registrations.register(f.owner, f.request);
    f.fetch.mockRejectedValueOnce(new GitError('GIT_REMOTE_UNAVAILABLE'));
    await expect(f.registrations.prepare(registration.id, f.owner, 'ApexClass')).rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' });
    expect(await f.registrations.get(registration.id, f.owner)).toMatchObject({ status: 'FAILED', lastCommitSha: f.first });
    expect(f.imports.listSources(f.owner)).toEqual([]);
    await expect(f.registrations.prepare(registration.id, 'another-user', 'ApexClass')).rejects.toMatchObject({ code: 'IMPORT_EXPIRED' });
  });

  it('공유 객체에서 서로 다른 SHA를 동시에 restore해도 index와 결과가 섞이지 않는다', async () => {
    const f = await fixture();
    const objects = new GitObjectStore(f.source, path.join(f.source, '.git'));
    const old = f.first;
    await writeFile(path.join(f.source, 'force-app/main/default/classes/Hello.cls'), 'public class Hello { /* new */ }\n');
    const current = f.commit();
    const materializer = new GitMaterializer(objects);
    const a = path.join(f.root, 'compare-a'), b = path.join(f.root, 'compare-b');
    await Promise.all([materializer.materialize(old, '.', a, { metadataType: 'ApexClass' }),
      materializer.materialize(current, '.', b, { metadataType: 'ApexClass' })]);
    expect(await readFile(path.join(a, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toContain('first');
    expect(await readFile(path.join(b, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toContain('new');
    expect((await readdir(f.root)).some((entry) => entry.startsWith('.restore-'))).toBe(false);
    expect(git(f.source, ['status', '--porcelain'])).toBe('');
  });

  it('실제 partial fetch에서 선택 blob만 명시적으로 받고 restore 재실행은 수신을 재사용한다', async () => {
    const f = await fixture();
    await writeFile(path.join(f.source, '.gitattributes'), '*.cls text eol=crlf working-tree-encoding=SHIFT-JIS\n');
    const sha = f.commit();
    git(f.source, ['config', 'uploadpack.allowFilter', 'true']);
    const receiver = path.join(f.root, 'partial');
    await mkdir(receiver);
    const gitDirectory = path.join(receiver, 'repository.git');
    git(receiver, ['init', '--bare', gitDirectory]);
    const remote = pathToFileURL(f.source).href;
    const fetch = (ids: string[]) => {
      git(receiver, [`--git-dir=${gitDirectory}`, 'fetch', '--filter=blob:none', '--no-tags', '--depth=1', '--', remote, ...ids]);
      git(receiver, [`--git-dir=${gitDirectory}`, 'config', '--remove-section', `remote.${remote}`]);
    };
    fetch([sha]);
    const hydrated: string[] = [];
    const objects = new GitObjectStore(receiver, gitDirectory, async (ids) => { hydrated.push(...ids); fetch(ids); });
    const materializer = new GitMaterializer(objects);
    const initial = await materializer.materialize(sha, '.', path.join(f.root, 'partial-a'), { metadataType: 'ApexClass' });
    expect(hydrated.length).toBeGreaterThan(0);
    const count = hydrated.length;
    const repeated = await materializer.materialize(sha, '.', path.join(f.root, 'partial-b'), { metadataType: 'ApexClass' });
    expect(repeated.checksum).toBe(initial.checksum);
    expect(hydrated).toHaveLength(count);
    const unrelated = git(f.source, ['rev-parse', `${sha}:force-app/main/default/triggers/Other.trigger`]);
    const attributes = git(f.source, ['rev-parse', `${sha}:.gitattributes`]);
    expect(hydrated).not.toContain(unrelated);
    expect(hydrated).not.toContain(attributes);
    expect(() => git(receiver, [`--git-dir=${gitDirectory}`, 'cat-file', '-e', unrelated])).toThrow();
  });

  it('동일 데이터 경로의 두 번째 서버를 차단하고 종료 후 다시 열 수 있다', async () => {
    const root = await temporary();
    const databasePath = path.join(root, 'db.sqlite');
    const cache = await GitCache.create(databasePath);
    await expect(GitCache.create(databasePath)).rejects.toThrow('Git 캐시를 열 수 없습니다');
    await cache.close();
    const next = await GitCache.create(databasePath);
    await next.close();
  });

  it('동일 캐시 쓰기는 직렬화하고 다른 권한 범위와 캐시는 격리한다', async () => {
    const cache = await GitCache.create(':memory:');
    cleanups.push(() => cache.close());
    const a = await cache.acquire(['owner-a', 'repository']);
    let waitingResolved = false;
    const waiting = cache.acquire(['owner-a', 'repository']).then((lease) => { waitingResolved = true; return lease; });
    const b = await cache.acquire(['owner-b', 'repository']);
    expect(b.directory).not.toBe(a.directory); expect(waitingResolved).toBe(false);
    await a.release();
    const next = await waiting; expect(next.directory).toBe(a.directory);
    await next.release(); await b.release();
  });

  it('캐시 용량 회수는 사용 중인 캐시를 보존하고 미사용 캐시만 제거한다', async () => {
    const root = await temporary();
    const cache = await GitCache.create(path.join(root, 'db.sqlite'), 100, 150);
    cleanups.push(() => cache.close());
    const a = await cache.acquire(['a']);
    await writeFile(path.join(a.directory, 'data'), 'a'.repeat(60));
    await expect(cache.acquire(['b'])).rejects.toMatchObject({ code: 'GIT_QUOTA_EXCEEDED' });
    expect(await readFile(path.join(a.directory, 'data'), 'utf8')).toHaveLength(60);
    await a.release();
    const b = await cache.acquire(['b']);
    await expect(access(a.directory)).rejects.toThrow();
    expect(b.directory).not.toBe(a.directory);
    await b.release();
  });

  it('용량을 넘긴 실패 캐시는 회수하고 다음 요청에서 재준비할 수 있다', async () => {
    const root = await temporary();
    const cache = await GitCache.create(path.join(root, 'db.sqlite'), 100, 150);
    cleanups.push(() => cache.close());
    const lease = await cache.acquire(['repository']);
    await writeFile(path.join(lease.directory, 'oversized'), 'x'.repeat(101));
    expect(() => lease.checkBytes(101)).toThrow();
    await lease.release();
    await expect(access(lease.directory)).rejects.toThrow();
    const retry = await cache.acquire(['repository']);
    expect(await readdir(retry.directory)).toEqual([]);
    await retry.release();
  });

  it('force push는 새 작업에 반영하고 삭제된 브랜치와 바뀐 저장소 식별자는 차단한다', async () => {
    const f = await fixture();
    const registration = await f.registrations.register(f.owner, f.request);
    const old = await f.registrations.prepare(registration.id, f.owner, 'ApexClass');
    git(f.source, ['checkout', '--orphan', 'replacement']);
    await writeFile(path.join(f.source, 'force-app/main/default/classes/Hello.cls'), 'public class Hello { /* rewritten history */ }');
    const rewritten = f.commit();
    git(f.source, ['branch', '-f', 'main', rewritten]);
    const next = await f.registrations.prepare(registration.id, f.owner, 'ApexClass');
    expect(next.expectedCommitSha).toBe(rewritten);
    expect(await readFile(path.join(f.imports.resolve(old.id, f.owner).realPath, 'force-app/main/default/classes/Hello.cls'), 'utf8')).toContain('first');
    git(f.source, ['branch', '-D', 'main']);
    await expect(f.registrations.prepare(registration.id, f.owner, 'ApexClass')).rejects.toThrow();
    expect((await f.registrations.get(registration.id, f.owner)).lastCommitSha).toBe(rewritten);
    vi.mocked(f.provider.inspect).mockResolvedValueOnce({ ...normalizeRepository('owner/project', 'github'), repositoryId: 'different-repository', private: false });
    await expect(f.registrations.sync(registration.id, f.owner)).rejects.toMatchObject({ code: 'REPOSITORY_UNAVAILABLE' });
  });

  it('비교 큐는 두 작업을 동시에 실행하고 모든 lane의 종료를 기다린다', async () => {
    const queue = new SingleJobQueue(2);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const started: string[] = [];
    const a = queue.enqueue('a', async () => { started.push('a'); await gate; });
    const b = queue.enqueue('b', async () => { started.push('b'); await gate; });
    const c = queue.enqueue('c', async () => { started.push('c'); });
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    expect(await queue.waitForIdle(5)).toBe(false);
    finish(); await Promise.all([a, b, c]); await queue.onIdle();
    expect(started).toEqual(['a', 'b', 'c']); expect(queue.status().activeJobId).toBeUndefined();
  });
});
