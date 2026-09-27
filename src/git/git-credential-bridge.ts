import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitRepositoryAddress } from './git-repository.js';
import { GitError } from './git-errors.js';

export interface GitFetchCredential { username: string; password: string }

// This helper contains no credential. It gets a task-scoped credential through
// authenticated loopback IPC, and writes only the Git credential protocol.
const helper = `const http = require('node:http');
if (process.argv[2] !== 'get') process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 8192) process.exit(1); });
process.stdin.on('end', () => {
  const req = http.request({host:'127.0.0.1', port:Number(process.env.SFUD_GIT_BRIDGE_PORT),
    method:'POST', path:'/credential', headers:{'x-sfud-nonce':process.env.SFUD_GIT_BRIDGE_NONCE}}, res => {
    if (res.statusCode !== 200) { res.resume(); process.exitCode = 1; return; }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; if (body.length > 32768) req.destroy(); });
    res.on('end', () => { if (body.length <= 32768) process.stdout.write(body); });
  });
  req.setTimeout(5000, () => req.destroy());
  req.on('error', () => { process.exitCode = 1; });
  req.end(input);
});
`;

export async function createGitCredentialBridge(directory: string, repository: GitRepositoryAddress, credential: GitFetchCredential) {
  if ([credential.username, credential.password].some((value) => value.length === 0 || value.length > 8192 || /[\r\n\0]/u.test(value))) {
    throw new GitError('GIT_REAUTH_REQUIRED');
  }
  const nonce = randomBytes(32).toString('hex');
  const helperPath = path.join(directory, `credential-${randomBytes(12).toString('hex')}.cjs`);
  await writeFile(helperPath, helper, { mode: 0o600, flag: 'wx' });
  const clone = new URL(repository.cloneUrl);
  const allowedPaths = new Set([clone.pathname.slice(1), decodeURIComponent(clone.pathname.slice(1))]);
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 4096 }, (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const supplied = req.headers['x-sfud-nonce'];
    if (req.method !== 'POST' || req.url !== '/credential' || typeof supplied !== 'string'
      || !/^[a-f0-9]{64}$/u.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(nonce))) {
      res.writeHead(403).end(); req.resume(); return;
    }
    req.on('error', () => res.destroy());
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      const fields = new Map<string, string>();
      for (const line of body.split('\n').filter(Boolean)) {
        const equals = line.indexOf('=');
        const key = line.slice(0, equals);
        if (equals < 1 || fields.has(key)) { res.writeHead(403).end(); return; }
        fields.set(key, line.slice(equals + 1));
      }
      if (fields.get('protocol') !== 'https' || fields.get('host') !== repository.host
        || !allowedPaths.has(fields.get('path') ?? '')
        || (fields.has('username') && fields.get('username') !== credential.username)) {
        res.writeHead(403).end(); return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`username=${credential.username}\npassword=${credential.password}\n\n`);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) { await rm(helperPath, { force: true }); throw error; }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new GitError('GIT_PROCESS_FAILED');
  return {
    helperCommand: `!${shellQuote(process.execPath)} ${shellQuote(helperPath)}`,
    environment: { SFUD_GIT_BRIDGE_PORT: String(address.port), SFUD_GIT_BRIDGE_NONCE: nonce },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(helperPath, { force: true });
    },
  };
}

function shellQuote(value: string): string {
  // Git executes credential helper commands through its POSIX shell, including
  // Git for Windows. Only server-generated paths enter this command.
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
