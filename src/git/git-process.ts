import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git-errors.js';

export interface GitProcessOptions {
  cwd: string;
  input?: Buffer;
  gitDirectory?: string;
  workTree?: string;
  indexFile?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onDiskUsage?: (bytes: number) => void;
  additionalConfig?: readonly string[];
  bridgeEnvironment?: { SFUD_GIT_BRIDGE_PORT: string; SFUD_GIT_BRIDGE_NONCE: string };
}

export async function runIsolatedGit(args: readonly string[], options: GitProcessOptions): Promise<Buffer> {
  if (options.signal?.aborted) throw new GitError('IMPORT_CANCELLED');
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const emptyFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  Object.assign(env, {
    HOME: options.cwd, USERPROFILE: options.cwd, XDG_CONFIG_HOME: options.cwd,
    GIT_CEILING_DIRECTORIES: options.cwd,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyFile, GIT_CONFIG_SYSTEM: emptyFile,
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    ...options.bridgeEnvironment,
    GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: '', GIT_ALLOW_PROTOCOL: 'https', LC_ALL: 'C',
    ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
  });
  const settings = [
    'credential.helper=', 'core.askPass=', `core.hooksPath=${emptyFile}`,
    'core.fsmonitor=false', 'core.attributesFile=', 'core.autocrlf=false',
    'protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false',
    'http.proxy=', 'http.sslVerify=true', 'gc.auto=0', 'maintenance.auto=false',
    'fetch.recurseSubmodules=false', 'submodule.recurse=false', 'init.templateDir=',
  ];
  const finalArgs = [
    '--no-replace-objects', ...[...settings, ...(options.additionalConfig ?? [])].flatMap((value) => ['-c', value]),
    ...(options.gitDirectory === undefined ? [] : [`--git-dir=${options.gitDirectory}`]),
    ...(options.workTree === undefined ? [] : [`--work-tree=${options.workTree}`]), ...args,
  ];
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', finalArgs, {
      cwd: options.cwd, env, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input);
    const chunks: Buffer[] = [];
    const maximum = options.maxOutputBytes ?? 4 * 1024 * 1024;
    let bytes = 0;
    let failure: Error | undefined;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let diskCheck = Promise.resolve();
    let checking = false;
    const monitor = () => {
      if (checking || closed || options.onDiskUsage === undefined) return;
      checking = true;
      diskCheck = directorySize(options.cwd).then((size) => { options.onDiskUsage!(size); })
        .catch((error: unknown) => terminate(error instanceof GitError ? error : new GitError('GIT_QUOTA_EXCEEDED')))
        .finally(() => { checking = false; });
    };
    const interval = options.onDiskUsage === undefined ? undefined : setInterval(monitor, 100);
    interval?.unref();
    const timeout = setTimeout(() => terminate(new GitError('IMPORT_TIMEOUT')), options.timeoutMs ?? 120_000);
    timeout.unref();
    const abort = () => terminate(new GitError('IMPORT_CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) terminate(new GitError('GIT_QUOTA_EXCEEDED'));
      else if (failure === undefined) chunks.push(chunk);
    });
    // Drain, bound and discard stderr. Never propagate remote messages or paths.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) terminate(new GitError('GIT_QUOTA_EXCEEDED'));
    });
    child.once('error', () => { failure ??= new GitError('GIT_PROCESS_FAILED'); });
    child.once('close', (code) => {
      closed = true;
      if (failure !== undefined) kill('SIGKILL');
      clearInterval(interval);
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      void (async () => {
        await diskCheck;
        if (failure !== undefined) throw failure;
        if (code !== 0) throw new GitError('GIT_PROCESS_FAILED');
        if (options.onDiskUsage !== undefined) options.onDiskUsage(await directorySize(options.cwd));
        resolve(Buffer.concat(chunks));
      })().catch(reject);
    });
    function terminate(error: Error): void {
      if (failure !== undefined) return;
      failure = error;
      if (closed) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
    }
    function kill(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          env, shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
    }
  });
}

export async function directorySize(root: string): Promise<number> {
  let bytes = 0;
  let entries = 0;
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (directory !== root && error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of children) {
      if (++entries > 100_000) throw new GitError('GIT_QUOTA_EXCEEDED');
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new GitError('UNSAFE_PROJECT_PATH');
      if (entry.isDirectory()) directories.push(candidate);
      else {
        try { bytes += (await lstat(candidate)).size; }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
    }
  }
  return bytes;
}
