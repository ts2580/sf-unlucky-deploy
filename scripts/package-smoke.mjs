import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-smoke-'));

try {
  const suppliedTarball = process.argv[2];
  const tarball = suppliedTarball === undefined
    ? await createTarball(temporaryDirectory)
    : path.resolve(root, suppliedTarball);
  const listing = await run('tar', ['-tf', tarball], root);
  if (!listing.split(/\r?\n/u).includes('package/npm-shrinkwrap.json')) {
    throw new Error('릴리스 tarball에 npm-shrinkwrap.json이 없습니다.');
  }

  const prefix = path.join(temporaryDirectory, 'installed');
  await runNpm([
    'install', '--global', '--prefix', prefix, '--allow-scripts=sqlite3',
    tarball,
  ]);
  await runNpm(['ls', '--global', '--all', '--prefix', prefix]);

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const expectedVersion = packageJson.version;
  const executable = process.platform === 'win32'
    ? path.join(prefix, 'sfud.cmd')
    : path.join(prefix, 'bin', 'sfud');
  const actualVersion = (await run(executable, ['--version'], root)).trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`설치된 sfud 버전 불일치: ${actualVersion} != ${expectedVersion}`);
  }
  console.log(`package smoke 통과: ${path.basename(tarball)} · sfud ${actualVersion}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function createTarball(destination) {
  await run('npm', ['run', 'build'], root);
  const pack = JSON.parse(await runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', destination,
  ]));
  const result = Array.isArray(pack) ? pack[0] : undefined;
  if (result === undefined || typeof result.filename !== 'string') {
    throw new Error('npm pack 결과에서 tarball 이름을 확인할 수 없습니다.');
  }
  return path.join(destination, result.filename);
}

async function runNpm(args) {
  return await run('npx', ['--yes', 'npm@11.7.0', ...args], root);
}

async function run(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(' ')} 실패 (${code ?? 'signal'})\n${stderr}`));
    });
  });
}
