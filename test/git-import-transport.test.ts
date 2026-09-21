import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitCredentialBridge } from '../src/git/git-credential-bridge.js';
import { runIsolatedGit } from '../src/git/git-process.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GitClient } from '../src/git/git-client.js';
import { GithubPatCredentialProvider } from '../src/git/git-credential-provider.js';
import { GitError } from '../src/git/git-errors.js';
import { isPublicGitAddress, validateProviderUrl } from '../src/git/git-network.js';
import * as network from '../src/git/git-network.js';
import * as processRunner from '../src/git/git-process.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sfud-git-transport-'));
  roots.push(directory);
  return directory;
}

describe('격리 Git 수신과 credential bridge', { timeout: 30_000 }, () => {
  it('Git의 실제 credential helper가 지정 저장소에서만 credential을 수신하고 파일에 남기지 않는다', async () => {
    const directory = await root();
    const repository = normalizeRepository('https://github.com/owner/private');
    const bridge = await createGitCredentialBridge(directory, repository, { username: 'x-access-token', password: 'fixture-secret-never-persist' });
    try {
      const invoke = (repo: string) => runIsolatedGit(['credential', 'fill'], {
        cwd: directory, input: Buffer.from(`protocol=https\nhost=github.com\npath=${repo}\n\n`),
        additionalConfig: ['credential.useHttpPath=true', `credential.helper=${bridge.helperCommand}`],
        bridgeEnvironment: bridge.environment,
      });
      expect((await invoke('owner/private.git')).toString()).toContain('password=fixture-secret-never-persist');
      await expect(invoke('another/private.git')).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
      for (const file of await readdir(directory)) {
        expect(await readFile(path.join(directory, file), 'utf8')).not.toContain('fixture-secret-never-persist');
      }
      const response = await fetch(`http://127.0.0.1:${bridge.environment.SFUD_GIT_BRIDGE_PORT}/credential`, {
        method: 'POST', headers: { 'x-sfud-nonce': 'x'.repeat(64) }, body: 'protocol=https\nhost=github.com\npath=owner/private.git\n',
      });
      expect(response.status).toBe(403);
      for (const body of [
        'protocol=https\nhost=gitlab.com\npath=owner/private.git\n',
        'protocol=http\nhost=github.com\npath=owner/private.git\n',
        'protocol=https\nhost=github.com\nhost=github.com\npath=owner/private.git\n',
        'protocol=https\nhost=github.com\npath=owner/private.git\nusername=attacker\n',
      ]) {
        expect((await fetch(`http://127.0.0.1:${bridge.environment.SFUD_GIT_BRIDGE_PORT}/credential`, {
          method: 'POST', headers: { 'x-sfud-nonce': bridge.environment.SFUD_GIT_BRIDGE_NONCE }, body,
        })).status).toBe(403);
      }
    } finally { await bridge.close(); }
    expect(await readdir(directory)).toEqual([]);
  });

  it('HTTPS와 명시적 호스트만 허용하고 사설·루프백·metadata·IPv4 mapped 주소를 거절한다', () => {
    for (const value of ['127.0.0.1', '0.0.0.0', '10.10.1.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '100.100.100.200', '224.0.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) {
      expect(isPublicGitAddress(value), value).toBe(false);
    }
    expect(isPublicGitAddress('140.82.114.3')).toBe(true);
    expect(isPublicGitAddress('2606:4700::1111')).toBe(true);
    for (const value of ['https://api.github.com.evil.test/repo', 'http://github.com/repo', 'https://secret@github.com/repo', 'https://github.com:8443/repo']) {
      expect(() => validateProviderUrl(value)).toThrow();
    }
    expect(() => validateProviderUrl('https://gitlab.com/api/v4/projects', 'api.github.com')).toThrow();
  });

  it('fetch가 검증한 DNS 주소와 단일 SHA를 사용하고 shallow/no-submodule/credential 정리를 적용한다', async () => {
    const directory = await root();
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async (args) => Buffer.from(args[0] === 'cat-file' ? 'commit\n' : ''));
    const repository = normalizeRepository('https://github.com/owner/private');
    await new GitClient().fetch({ directory, repository, commitSha: 'a'.repeat(40),
      credentialProvider: new GithubPatCredentialProvider('secret-fetch-fixture'), onDiskUsage: () => undefined });
    const [args, options] = execute.mock.calls[1]!;
    expect(args).toEqual(['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', repository.cloneUrl, 'a'.repeat(40)]);
    expect(options.additionalConfig).toContain('http.curloptResolve=github.com:443:140.82.114.3');
    expect(JSON.stringify(execute.mock.calls)).not.toContain('secret-fetch-fixture');
    expect(await readdir(directory)).toEqual([]);
    await expect(new GitClient().fetch({ directory, repository: { ...repository, cloneUrl: 'file:///tmp/evil' },
      commitSha: 'a'.repeat(40), onDiskUsage: () => undefined })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    await expect(access(path.join(directory, '.git-credentials'))).rejects.toThrow();
  });

  it('partial fetch는 tree에서 blob을 암묵적으로 가져오지 않고 누락 blob만 500개 단위로 명시적으로 hydration한다', async () => {
    const directory = await root();
    const commit = 'a'.repeat(40);
    const resolved = vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    const signal = new AbortController().signal;
    const onDiskUsage = vi.fn();
    const token = 'secret-partial-fetch-fixture';
    const ids = Array.from({ length: 1001 }, (_, index) => (index + 1).toString(16).padStart(40, '0'));
    const present = ids[0]!;
    const available = new Set(ids.filter((_id, index) => index % 3 === 0));
    const missing = ids.filter((_id, index) => index % 3 !== 0);
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async (args, options) => {
      if (args[0] === 'cat-file' && args[1] === '--batch-check=%(objectname) %(objecttype)') {
        const input = options.input?.toString('utf8').trimEnd().split('\n') ?? [];
        return Buffer.from(input.map((id) => `${id} ${available.has(id) ? 'blob' : 'missing'}`).join('\n') + '\n');
      }
      if (args[0] === 'ls-tree') return Buffer.from(`100644 blob ${present}\tforce-app/main.cls\0`);
      if (args[0] === 'cat-file' && args[1] === '-t') return Buffer.from('commit\n');
      return Buffer.from('');
    });
    const repository = normalizeRepository('https://github.com/owner/private');
    const store = await new GitClient().fetch({ directory, repository, commitSha: commit, partial: true,
      signal, onDiskUsage, credentialProvider: new GithubPatCredentialProvider(token) });

    const fetchCalls = () => execute.mock.calls.filter(([args]) => args[0] === 'fetch');
    const initial = fetchCalls()[0];
    expect(initial?.[0]).toEqual(['fetch', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', repository.cloneUrl, commit]);
    expect(initial?.[1].signal).toBe(signal);
    expect(initial?.[1].onDiskUsage).toBe(onDiskUsage);
    expect(initial?.[1].additionalConfig).toContain('http.curloptResolve=github.com:443:140.82.114.3');
    expect(initial?.[1].additionalConfig).toContain('credential.useHttpPath=true');
    expect(JSON.stringify(execute.mock.calls)).not.toContain(token);
    const removePromisorRemote = () => execute.mock.calls.filter(([args]) => args[0] === 'config');
    expect(removePromisorRemote()[0]?.[0]).toEqual(['config', '--local', '--remove-section', `remote.${repository.cloneUrl}`]);

    const tree = await store.listTree(commit, signal);
    expect(tree).toEqual([{ mode: '100644', type: 'blob', objectId: present, path: 'force-app/main.cls', size: -1 }]);
    expect(fetchCalls()).toHaveLength(1);
    const treeCall = execute.mock.calls.find(([args]) => args[0] === 'ls-tree');
    expect(treeCall?.[0]).not.toContain('-l');

    await store.prepareBlobs(ids, signal);
    const hydrationCalls = fetchCalls().slice(1);
    expect(hydrationCalls).toHaveLength(2);
    expect(hydrationCalls.flatMap(([, options]) => options.input?.toString('utf8').trimEnd().split('\n') ?? [])).toEqual(missing);
    for (const [args, options] of hydrationCalls) {
      expect(args).toContain('--stdin');
      expect(args).toContain(repository.cloneUrl);
      expect(options.signal).toBe(signal);
      expect(options.onDiskUsage).toBe(onDiskUsage);
      expect(options.additionalConfig).toContain('http.curloptResolve=github.com:443:140.82.114.3');
      expect(options.additionalConfig).toContain('credential.useHttpPath=true');
      expect(options.bridgeEnvironment?.SFUD_GIT_BRIDGE_PORT).toMatch(/^\d+$/u);
    }
    expect(hydrationCalls[0]?.[1].input?.toString('utf8').trimEnd().split('\n')).toHaveLength(500);
    expect(hydrationCalls[1]?.[1].input?.toString('utf8').trimEnd().split('\n')).toHaveLength(missing.length - 500);
    expect(JSON.stringify(execute.mock.calls)).not.toContain(token);
    expect((await readdir(directory)).filter((entry) => entry.startsWith('credential-'))).toEqual([]);
    expect(removePromisorRemote()).toHaveLength(3);
    for (const [, options] of removePromisorRemote()) {
      expect(options.signal).toBe(signal);
      expect(options.onDiskUsage).toBe(onDiskUsage);
    }
    expect(resolved).toHaveBeenCalledTimes(3);
  });

  it('partial hydration이 실패해도 원격 fetch credential bridge를 정리한다', async () => {
    const directory = await root();
    const commit = 'c'.repeat(40);
    const missing = 'd'.repeat(40);
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async (args, options) => {
      if (args[0] === 'cat-file' && args[1] === '--batch-check=%(objectname) %(objecttype)') {
        return Buffer.from(`${missing} missing\n`);
      }
      if (args[0] === 'cat-file' && args[1] === '-t') return Buffer.from('commit\n');
      if (args[0] === 'fetch' && options.input !== undefined) throw new GitError('GIT_PROCESS_FAILED');
      return Buffer.from('');
    });
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    const repository = normalizeRepository('https://github.com/owner/private');
    const store = await new GitClient().fetch({ directory, repository, commitSha: commit, partial: true,
      onDiskUsage: () => undefined, credentialProvider: new GithubPatCredentialProvider('secret-cleanup-fixture') });

    await expect(store.prepareBlobs([missing])).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
    expect(execute.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(2);
    expect((await readdir(directory)).filter((entry) => entry.startsWith('credential-'))).toEqual([]);
  });

  it('ls-remote가 DNS pin, 제한, credential IPC와 임시 디렉터리 정리를 적용한다', async () => {
    const directory = await root();
    const resolved = vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockResolvedValue(Buffer.from(
      'ref: refs/heads/main\tHEAD\n' + 'a'.repeat(40) + '\trefs/heads/main\n'));
    const repository = normalizeRepository('https://github.com/owner/private');
    const provider = new GithubPatCredentialProvider('secret-ls-remote-fixture');
    const output = await new GitClient().lsRemote({ repository, credentialProvider: provider });
    expect(output.toString('utf8')).toContain('refs/heads/main');
    expect(resolved).toHaveBeenCalledWith('github.com');
    const [args, options] = execute.mock.calls[0]!;
    expect(args).toEqual(['ls-remote', '--symref', '--', repository.cloneUrl, 'HEAD', 'refs/heads/*', 'refs/tags/*']);
    expect(options.timeoutMs).toBe(15_000);
    expect(options.maxOutputBytes).toBe(4 * 1024 * 1024);
    expect(options.additionalConfig).toContain('http.curloptResolve=github.com:443:140.82.114.3');
    expect(options.additionalConfig).toContain('credential.useHttpPath=true');
    expect(JSON.stringify(execute.mock.calls)).not.toContain('secret-ls-remote-fixture');
    expect(await readdir(directory)).toEqual([]);
  });

  it('ls-remote 실패를 remote unavailable로 매핑하고 실패 뒤 bridge와 디렉터리를 정리한다', async () => {
    const directory = await root();
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    vi.spyOn(processRunner, 'runIsolatedGit').mockRejectedValue(new GitError('GIT_PROCESS_FAILED'));
    const repository = normalizeRepository('https://github.com/owner/private');
    await expect(new GitClient().lsRemote({ repository, credentialProvider: new GithubPatCredentialProvider('failure-secret') }))
      .rejects.toMatchObject({ code: 'GIT_REMOTE_UNAVAILABLE' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('ls-remote 취소는 process에 signal을 전달하고 모든 임시 자원을 정리한다', async () => {
    const directory = await root();
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async (_args, options) => {
      const signal = options.signal;
      if (signal === undefined) throw new Error('signal was not forwarded');
      started();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new GitError('IMPORT_CANCELLED');
    });
    const controller = new AbortController();
    const repository = normalizeRepository('https://github.com/owner/private');
    const pending = new GitClient().lsRemote({ repository, credentialProvider: new GithubPatCredentialProvider('cancel-secret'), signal: controller.signal });
    await startedPromise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('동시 ls-remote는 20개로 제한하고 한도를 넘긴 호출을 즉시 거절한다', async () => {
    const directory = await root();
    vi.spyOn(network, 'resolveGitHost').mockResolvedValue({ address: '140.82.114.3', family: 4 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.spyOn(processRunner, 'runIsolatedGit').mockImplementation(async () => {
      await gate;
      return Buffer.from('');
    });
    const repository = normalizeRepository('https://github.com/owner/private');
    const requests = Array.from({ length: 20 }, () => new GitClient().lsRemote({
      repository, credentialProvider: new GithubPatCredentialProvider('concurrency-secret'),
    }));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(20), { timeout: 5_000 });
    await expect(new GitClient().lsRemote({ repository, credentialProvider: new GithubPatCredentialProvider('overflow-secret') }))
      .rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    release();
    await Promise.all(requests);
    expect(await readdir(directory)).toEqual([]);
  });
});
