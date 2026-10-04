import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = path.join(root, 'sf-unlucky-deploy-source-20260929.zip');
const entries = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
}).toString('utf8').split('\0').filter(Boolean).map((entry) => entry.replaceAll(path.sep, '/')))]
  .filter((entry) => include(entry)).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

const files = [];
for (const name of entries) {
  const absolute = path.join(root, ...name.split('/'));
  let info;
  try { info = await lstat(absolute); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) continue;
  files.push({ name, data: await readFile(absolute), mode: (info.mode & 0o111) === 0 ? 0o100644 : 0o100755 });
}

const archive = createZip(files);
const temporary = `${output}.tmp`;
try {
  await writeFile(temporary, archive, { mode: 0o600 });
  await rename(temporary, output);
} finally { await rm(temporary, { force: true }); }
process.stdout.write(`Created ${path.basename(output)} (${files.length} files, ${archive.byteLength} bytes)\n`);

function include(name) {
  if (name.startsWith('/') || name.split('/').some((part) => part === '..')) return false;
  if (name === '.env.example') return true;
  const parts = name.toLowerCase().split('/');
  if (parts.some((part) => ['.git', '.sf', '.sfdx', '.sfud', '.sfud-local', 'node_modules', 'dist',
    'coverage', 'working', 'docs', 'test-results', 'playwright-report', '.cache', '__pycache__'].includes(part))) return false;
  const base = parts.at(-1) ?? '';
  return !(/^\.env(?:\.|$)/u.test(base)
    || ['.npmrc', '.netrc', '.git-credentials', '.pypirc', 'agents.md'].includes(base)
    || /\.(?:zip|tgz|tar|gz|log|db|db3|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/u.test(base)
    || /\.(?:wal|shm|journal|pem|key|p12|pfx|jks)$/u.test(base)
    || /(?:^|\.)(?:id_rsa|id_ed25519)(?:$|\.)/u.test(base)
    || /(?:^|\.)tmp(?:\.|$)/u.test(base)
    || base === '.ds_store');
}

function createZip(items) {
  if (items.length > 0xffff) throw new Error('소스 파일 수가 ZIP32 한도를 초과했습니다.');
  const local = [];
  const central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const compressed = deflateRawSync(item.data, { level: 9 });
    const crc = crc32(item.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(33, 12); // Fixed DOS date: 1980-01-01 00:00:00.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.byteLength, 18);
    header.writeUInt32LE(item.data.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    local.push(header, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE((3 << 8) | 20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.byteLength, 20);
    directory.writeUInt32LE(item.data.byteLength, 24);
    directory.writeUInt16LE(name.byteLength, 28);
    directory.writeUInt32LE((item.mode << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.byteLength + name.byteLength + compressed.byteLength;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralData.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralData, end]);
}

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
