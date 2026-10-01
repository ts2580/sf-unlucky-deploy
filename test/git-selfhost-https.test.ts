import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitClient } from '../src/git/git-client.js';
import { normalizeRepository } from '../src/git/git-repository.js';
import { GithubPatCredentialProvider } from '../src/git/git-credential-provider.js';
import * as network from '../src/git/git-network.js';
import * as runner from '../src/git/git-process.js';

afterEach(() => vi.restoreAllMocks());
// Git for Windows does not necessarily expose openssl on PATH. Do not report a
// skipped fixture as proof of the Windows transport; run it on equipped hosts.
const hasOpenSsl = spawnSync('openssl', ['version'], { timeout: 5000 }).status === 0;
describe.skipIf(!hasOpenSsl)('셀프호스트 실제 HTTPS Git 전송', { timeout: 30_000 }, () => {
  it.each([false, true])('TLS·인증·context path·포트를 유지하며 refs/partial fetch/재시도를 수행한다 (branch=%s)', async (branch) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-https-fixture-'));
    const source = path.join(root, 'source.git');
    const cache = path.join(root, 'cache');
    const cert = path.join(root, 'cert.pem');
    const key = path.join(root, 'key.pem');
    const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot,
      HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
    const git = (directory: string, args: string[], input?: Buffer) => {
      const result = spawnSync('git', ['-c', 'init.templateDir=', `--git-dir=${directory}`, ...args], { cwd: root, env, input, timeout: 10000 });
      if (result.status !== 0) throw new Error(`Fixture git failed: ${result.status}`);
      return result.stdout.toString().trim();
    };
    const requests: Array<{ url: string; host: string | undefined; authorized: boolean }> = [];
    const token = 'fixture-https-token';
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await mkdir(cache);
      const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=git-fixture.example.test', '-addext', 'subjectAltName=DNS:git-fixture.example.test', '-keyout', key, '-out', cert], { timeout: 15000, env });
      expect(certificate.status).toBe(0);
      git(source, ['init', '--bare', source]);
      git(source, ['config', 'uploadpack.allowFilter', 'true']);
      git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
      const ids = ['first', 'second', 'third'].map((body) => git(source, ['hash-object', '-w', '--stdin'], Buffer.from(body)));
      const tree = git(source, ['mktree'], Buffer.from(ids.map((id, index) => `100644 blob ${id}\tfile${index}.cls\n`).join('')));
      const commit = git(source, ['commit-tree', tree, '-m', 'fixture']);
      git(source, ['update-ref', 'refs/heads/main', commit]);
      git(source, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      const prefix = '/bitbucket/scm/TEAM/project.git';
      server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
        const authorized = req.headers.authorization === `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        requests.push({ url: req.url ?? '', host: req.headers.host, authorized });
        if (!authorized) { req.resume(); res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end(); return; }
        const url = new URL(req.url!, 'https://fixture.invalid');
        if (!url.pathname.startsWith(`${prefix}/`)) { req.resume(); res.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', (data: Buffer) => chunks.push(data));
        req.on('end', () => {
          const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(Buffer.concat(chunks)) : Buffer.concat(chunks);
          const result = spawnSync('git', ['http-backend'], { cwd: root, timeout: 10000, input: body, maxBuffer: 4 * 1024 * 1024,
            env: { ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
              PATH_INFO: `/source.git${url.pathname.slice(prefix.length)}`, QUERY_STRING: url.search.slice(1),
              REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length),
              HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''), REMOTE_USER: 'fixture' } });
          if (result.status !== 0) { res.writeHead(500).end(); return; }
          const boundary = result.stdout.indexOf('\r\n\r\n');
          if (boundary < 0) { res.writeHead(500).end(); return; }
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of result.stdout.subarray(0, boundary).toString().split('\r\n')) {
            const separator = line.indexOf(':');
            const name = line.slice(0, separator), value = line.slice(separator + 1).trim();
            if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
            else headers[name] = value;
          }
          res.writeHead(status, headers).end(result.stdout.subarray(boundary + 4));
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTPS port');
      const repository = normalizeRepository(`https://git-fixture.example.test:${address.port}${prefix}`, 'bitbucket');
      vi.spyOn(network, 'resolveGitHost').mockImplementation(async (host) => {
        expect(host).toBe('git-fixture.example.test');
        return { address: '127.0.0.1', family: 4 };
      });
      const realRun = runner.runIsolatedGit;
      const execute = vi.spyOn(runner, 'runIsolatedGit').mockImplementation((args, options) => realRun(args, {
        ...options, additionalConfig: [...(options.additionalConfig ?? []), `http.sslCAInfo=${cert}`],
      }));
      const client = new GitClient();
      const credentialProvider = new GithubPatCredentialProvider(token);
      expect((await client.lsRemote({ repository, credentialProvider })).toString()).toContain(`refs/heads/main`);
      const options = { directory: cache, repository, credentialProvider, commitSha: commit, partial: true,
        ...(branch ? { ref: 'main' } : {}), onDiskUsage: () => undefined };
      const objects = await client.fetch(options);
      const gitDirectory = path.join(cache, 'repository.git');
      const check = () => git(gitDirectory, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], Buffer.from(ids.join('\n') + '\n'));
      expect(check()).toBe(ids.map((id) => `${id} missing`).join('\n'));
      await objects.prepareBlobs(ids.slice(0, 2));
      expect(check()).toContain(`${ids[0]} blob`);
      expect(check()).toContain(`${ids[2]} missing`);
      const target = path.join(root, 'restored');
      await mkdir(target);
      const entries = (await objects.listTree(commit)).filter((entry) => entry.path !== 'file2.cls');
      await objects.restoreFiles(commit, '.', entries, target, 1024, 4096);
      expect(await readFile(path.join(target, 'file0.cls'), 'utf8')).toBe('first');
      const reopened = await client.fetch(options);
      await expect(reopened.prepareBlobs(['f'.repeat(40)])).rejects.toMatchObject({ code: 'GIT_PROCESS_FAILED' });
      await reopened.prepareBlobs([ids[2]!]);
      expect((await reopened.readBlob(ids[2]!, 1024)).toString()).toBe('third');
      expect(git(gitDirectory, ['config', '--local', '--list'])).not.toMatch(/promisor|partialclonefilter|negotiationalgorithm/iu);
      expect(requests.some((request) => !request.authorized)).toBe(true);
      expect(requests.every((request) => request.host === new URL(repository.cloneUrl).host && request.url.startsWith(prefix))).toBe(true);
      expect(JSON.stringify(execute.mock.calls)).not.toContain(token);
    } finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
