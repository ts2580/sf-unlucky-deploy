import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import path from 'node:path';

import { createPrivateHomeFile, getHomeConfigPaths, readPrivateHomeFile } from '../../config/composition.js';
import { SfudError } from '../../core/errors.js';

interface UiRecord {
  version: 1;
  id: string;
  pid: number;
  host: string;
  port: number;
  controlPort: number;
  token: string;
}
interface ControlReply { service: 'sfud-control'; id: string; status: 'running' | 'stopped' | 'failed' }
interface StoredRecord { file: string; bytes: Buffer; identity: { dev: number; ino: number }; record: UiRecord }
const RECORD_NAME = /^ui-\d+-[0-9a-f-]{36}\.json$/u;
const MAX_MESSAGE = 4096;

/** Separate loopback-only protocol: never exposes shutdown through the web UI. */
export async function startUiControl(
  directory: string, ui: { host: string; port: number }, shutdown: () => Promise<void>,
): Promise<{ dispose(): Promise<void> }> {
  const record: UiRecord = { version: 1, id: randomUUID(), pid: process.pid, ...ui,
    controlPort: 0, token: randomBytes(32).toString('hex') };
  let stopping: Promise<void> | undefined;
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.setTimeout(1500, () => socket.destroy());
    socket.on('data', function receive(chunk: Buffer) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_MESSAGE) { socket.destroy(); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      socket.removeListener('data', receive);
      let request: { token?: unknown; id?: unknown; operation?: unknown };
      try { request = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as typeof request; }
      catch { socket.destroy(); return; }
      if (request === null || typeof request !== 'object' || typeof request.token !== 'string'
        || !/^[a-f0-9]{64}$/u.test(request.token) || request.id !== record.id
        || !timingSafeEqual(Buffer.from(request.token), Buffer.from(record.token))) {
        socket.destroy(); return;
      }
      const reply = (status: ControlReply['status']) => {
        socket.end(`${JSON.stringify({ service: 'sfud-control', id: record.id, status })}\n`);
      };
      if (request.operation === 'status') { reply('running'); return; }
      if (request.operation !== 'stop') { socket.destroy(); return; }
      socket.setTimeout(0);
      stopping ??= Promise.resolve().then(shutdown);
      void stopping.then(() => reply('stopped'), () => reply('failed'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('UI 제어 주소를 확인하지 못했습니다.');
  record.controlPort = address.port;
  const file = path.join(directory, `ui-${record.port}-${record.id}.json`);
  let identity: { dev: number; ino: number };
  try { identity = await createPrivateHomeFile(file, `${JSON.stringify(record)}\n`); }
  catch (error) { server.close(); throw error; }
  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Do not await active sockets: the authenticated stop request is waiting
      // for app.close() to finish before it receives its acknowledgement.
      server.close();
      try {
        const current = await lstat(file);
        if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write('[UI_CONTROL_CLEANUP_FAILED] 종료된 UI의 실행 기록을 정리하지 못했습니다.\n');
      }
    },
  };
}

function readRecord(bytes: Buffer): UiRecord {
  const record = JSON.parse(bytes.toString('utf8')) as UiRecord;
  if (record === null || typeof record !== 'object' || record.version !== 1
    || typeof record.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.id)
    || !Number.isSafeInteger(record.pid) || record.pid < 1
    || typeof record.host !== 'string' || record.host.length > 253
    || !validPort(record.port) || !validPort(record.controlPort)
    || typeof record.token !== 'string' || !/^[a-f0-9]{64}$/u.test(record.token)) throw new Error('Invalid UI record');
  return record;
}

function validPort(value: number): boolean { return Number.isInteger(value) && value > 0 && value <= 65535; }

async function exchange(record: UiRecord, operation: 'status' | 'stop', timeout: number): Promise<ControlReply> {
  return await new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host: '127.0.0.1', port: record.controlPort });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error('UI 제어 응답 대기 시간이 지났습니다.')), timeout);
    const finish = (error?: Error, reply?: ControlReply) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error !== undefined) reject(error); else resolve(reply!);
    };
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('UI 제어 연결이 종료되었습니다.')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: record.id, token: record.token, operation })}\n`));
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_MESSAGE) { finish(new Error('Invalid UI reply')); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const reply = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as ControlReply;
        if (reply?.service !== 'sfud-control' || reply.id !== record.id
          || !['running', 'stopped', 'failed'].includes(reply.status)) throw new Error('Invalid UI reply');
        finish(undefined, reply);
      } catch { finish(new Error('UI 실행 인스턴스를 확인하지 못했습니다.')); }
    });
  });
}

export async function stopWebUi(
  options: { port?: number; host?: string } = {}, environment: NodeJS.ProcessEnv = process.env,
): Promise<{ stopped: boolean; host?: string; port?: number }> {
  const directory = getHomeConfigPaths(environment).directory;
  let files: string[];
  try { files = (await readdir(directory)).filter((file) => RECORD_NAME.test(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stopped: false }; throw error; }
  const records: StoredRecord[] = [];
  for (const file of files) {
    const filename = path.join(directory, file);
    let bytes: Buffer;
    let identity;
    try {
      identity = await lstat(filename);
      bytes = await readPrivateHomeFile(filename, MAX_MESSAGE);
      const after = await lstat(filename);
      if (identity.dev !== after.dev || identity.ino !== after.ino) continue;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let record: UiRecord;
    try { record = readRecord(bytes); } catch { continue; }
    records.push({ file: filename, bytes, identity, record });
  }
  const live: UiRecord[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, records.length) }, async () => {
    while (next < records.length) {
      const stored = records[next++]!;
      const { record } = stored;
      try {
        const status = await exchange(record, 'status', 1500);
        if (status.status === 'running' && (options.port === undefined || options.port === record.port)
          && (options.host === undefined || options.host === record.host)) live.push(record);
      } catch (error) {
        // A refused connection proves the recorded listener is gone. Keep
        // records on timeouts, authentication failures, or transient errors.
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') await removeStaleRecord(stored);
      }
    }
  }));
  if (live.length === 0) return { stopped: false };
  if (live.length > 1) throw new SfudError('UI_STOP_AMBIGUOUS', `실행 중인 UI가 여러 개입니다 (${live.map((record) => `${record.host}:${record.port}`).join(', ')}). --port와 필요 시 --host로 선택하세요.`);
  const record = live[0]!;
  try {
    if ((await exchange(record, 'stop', 60_000)).status !== 'stopped') throw new Error('Shutdown failed');
  } catch { throw new SfudError('UI_STOP_FAILED', 'UI 정상 종료를 확인하지 못했습니다. 실행 터미널의 오류를 확인하세요.'); }
  return { stopped: true, host: record.host, port: record.port };
}

async function removeStaleRecord(stored: StoredRecord): Promise<void> {
  try {
    const current = await lstat(stored.file);
    if (current.dev !== stored.identity.dev || current.ino !== stored.identity.ino) return;
    if (!(await readPrivateHomeFile(stored.file, MAX_MESSAGE)).equals(stored.bytes)) return;
    const after = await lstat(stored.file);
    if (after.dev === stored.identity.dev && after.ino === stored.identity.ino) await unlink(stored.file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
