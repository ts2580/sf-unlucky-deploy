import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/git/git-client.js';
import { GitError } from '../src/git/git-errors.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import * as processRunner from '../src/git/git-process.js';
import * as network from '../src/git/git-network.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('실제 Git partial blob 수신', { timeout: 30_000 }, () => {
  it.each([false, true])('고정 commit / branch=%s에서 누락 blob만 수신·복원하고 promisor 설정을 남기지 않는다', async (branch) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-real-partial-'));
    roots.push(root);
    const source = path.join(root, 'source.git');
    const directory = path.join(root, 'cache');
    await mkdir(directory);
    const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
      HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (gitDirectory: string, args: readonly string[], input?: Buffer) => {
      const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'init.templateDir=',
        `--git-dir=${gitDirectory}`, ...args], { cwd: root, env, input, timeout: 15_000 });
      if (result.status !== 0) throw new GitError('GIT_PROCESS_FAILED');
      return result.stdout;
    };
    git(source, ['init', '--bare', source]);
    git(source, ['config', 'uploadpack.allowFilter', 'true']);
    git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const contents = ['first blob\n', 'second blob\n', 'unselected blob\n'];
    const ids = contents.map((value) => git(source, ['hash-object', '-w', '--stdin'], Buffer.from(value)).toString().trim());
    const tree = git(source, ['mktree'], Buffer.from(ids.map((id, index) => `100644 blob ${id}\tfile${index}.cls\n`).join(''))).toString().trim();
    const commit = git(source, ['commit-tree', tree], Buffer.from('fixture\n')).toString().trim();
    git(source, ['update-ref', 'refs/heads/main', commit]);

    const repository = normalizeRepository('https://git-fixture.example/group/project.git', 'gitlab');
    const localUrl = pathToFileURL(source).href;
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '192.0.2.1', family: 4 });
    const originalRun = processRunner.runIsolatedGit;
    // Use the production GitClient and object reader with real Git processes.
    // Only the network transport is replaced by a local file:// upload-pack;
    // no subprocess output is fabricated and no external host is contacted.
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async (args, options) => {
      const localArgs = args.map((arg) => arg.replaceAll(repository.cloneUrl, localUrl));
      if (args[0] !== 'fetch') return originalRun(localArgs, options);
      return git(options.gitDirectory!, [
        ...(options.additionalConfig ?? []).flatMap((value) => ['-c', value.replaceAll(repository.cloneUrl, localUrl)]),
        ...localArgs,
      ], options.input);
    });
    const fetchOptions = { directory, repository, commitSha: commit, partial: true,
      ...(branch ? { ref: 'main' } : {}), onDiskUsage: () => undefined };
    const store = await new GitClient().fetch(fetchOptions);
    const gitDirectory = path.join(directory, 'repository.git');
    const check = () => git(gitDirectory, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], Buffer.from(ids.join('\n') + '\n')).toString();
    expect(check()).toBe(ids.map((id) => `${id} missing\n`).join(''));
    const entries = await store.listTree(commit);
    expect(entries).toHaveLength(3);
    const selected = entries.filter((entry) => entry.path !== 'file2.cls');
    await store.prepareBlobs([...selected.map((entry) => entry.objectId), selected[0]!.objectId]);
    expect(check()).toBe(`${ids[0]} blob\n${ids[1]} blob\n${ids[2]} missing\n`);
    const destination = path.join(root, 'restored');
    await mkdir(destination);
    await store.restoreFiles(commit, '.', selected, destination, 1024, 4096);
    expect(await readFile(path.join(destination, 'file0.cls'), 'utf8')).toBe(contents[0]);
    expect(await readFile(path.join(destination, 'file1.cls'), 'utf8')).toBe(contents[1]);
    expect(await readdir(destination)).toEqual(['file0.cls', 'file1.cls']);
    const hydrated = execute.mock.calls.filter(([args]) => args[0] === 'fetch' && args.includes('--stdin'));
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]![1].additionalConfig).toContain('fetch.negotiationAlgorithm=noop');
    const config = () => git(gitDirectory, ['config', '--local', '--list']).toString();
    expect(config()).not.toMatch(/promisor|partialclonefilter|negotiationalgorithm/iu);

    // Reusing the cache must retain unselected missing objects until requested.
    const reopened = await new GitClient().fetch(fetchOptions);
    expect(check()).toContain(`${ids[2]} missing`);
    expect((await reopened.readBlob(ids[2]!, 1024)).toString()).toBe(contents[2]);
    expect(config()).not.toMatch(/promisor|partialclonefilter|negotiationalgorithm/iu);
    // A rejected object request must not leave a remote that readers could use.
    await expect(reopened.prepareBlobs(['f'.repeat(40)])).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
    expect(config()).not.toMatch(/promisor|partialclonefilter|negotiationalgorithm/iu);
  });
});
