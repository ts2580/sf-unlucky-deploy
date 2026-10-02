import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertPackedMetadataMatches, assertSafeArchive, verifyUiAssetPaths } from './package-archive-policy.mjs';

const root = process.cwd();
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-package-smoke-'));
let ui;

try {
  const arguments_ = process.argv.slice(2);
  const useExistingBuild = arguments_.includes('--use-existing-build');
  const positionalArguments = arguments_.filter((argument) => argument !== '--use-existing-build');
  if (positionalArguments.length > 1) throw new Error('package smoke에는 tarball 경로를 하나만 지정할 수 있습니다.');
  const [suppliedTarball] = positionalArguments;
  const tarball = suppliedTarball === undefined
    ? await createTarball(temporaryDirectory, useExistingBuild)
    : path.resolve(root, suppliedTarball);
  const entries = (await readTarball(tarball, '-tf')).split(/\r?\n/u).filter(Boolean);
  assertSafeArchive(entries);
  if (!entries.includes('package/npm-shrinkwrap.json')) throw new Error('릴리즈 tarball에 npm-shrinkwrap.json이 없습니다.');
  const archivePackageJson = JSON.parse(await readTarball(tarball, '-xOf', 'package/package.json'));
  const sourcePackageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assertPackedMetadataMatches(archivePackageJson, sourcePackageJson);
  if (!entries.includes('package/dist/cli.js') || !entries.includes('package/dist/ui/index.html')) {
    throw new Error('tarball에 실행 파일 또는 UI index.html이 없습니다.');
  }
  await verifyUiAssets(tarball, entries);
  await verifySourceMaps(tarball, entries);

  const prefix = path.join(temporaryDirectory, 'installed');
  await runNpm(['install', '--global', '--prefix', prefix, '--allow-scripts=sqlite3', tarball]);
  await runNpm(['ls', '--global', '--all', '--prefix', prefix]);
  const executable = process.platform === 'win32' ? path.join(prefix, 'sfud.cmd') : path.join(prefix, 'bin', 'sfud');
  const actualVersion = (await run(executable, ['--version'], temporaryDirectory)).trim();
  if (actualVersion !== sourcePackageJson.version) throw new Error(`설치된 sfud 버전 불일치: ${actualVersion} != ${sourcePackageJson.version}`);
  const help = await run(executable, ['--help'], temporaryDirectory);
  if (!help.includes('Salesforce')) throw new Error('설치된 CLI 도움말이 예상한 명령 출력을 반환하지 않습니다.');

  const configDirectory = path.join(temporaryDirectory, 'home-config');
  const env = { ...selectedNodeEnvironment(), SFUD_CONFIG_DIR: configDirectory };
  const configPath = (await run(executable, ['config', 'path'], temporaryDirectory, env)).trim();
  if (configPath !== path.join(configDirectory, 'config.json')) throw new Error('설치된 CLI의 홈 설정 경로가 일치하지 않습니다.');
  await run(executable, ['config', 'init'], temporaryDirectory, env);
  const originalConfig = await readFile(configPath);
  const configuration = JSON.parse(originalConfig.toString('utf8'));
  if (configuration.version !== 1 || configuration.env?.LOCAL !== 'true' || configuration.env?.SFUD_DATA_DIR !== 'data/local') {
    throw new Error('홈 설정 초기화가 개인 모드와 고정 데이터 경로를 생성하지 않았습니다.');
  }
  let reinitializationRejected = false;
  try { await run(executable, ['config', 'init'], temporaryDirectory, env); }
  catch { reinitializationRejected = true; }
  if (!reinitializationRejected || !(await readFile(configPath)).equals(originalConfig)) {
    throw new Error('홈 설정 초기화 재실행이 기존 설정을 덮어썼습니다.');
  }

  const dataDirectory = path.join(configDirectory, 'data', 'local');
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', sourcePackageJson.name);
  ui = startUi(path.join(packageRoot, 'dist/cli.js'), prefix, ['ui', '--port', String(port), '--no-open'], env);
  const health = await waitForUi(url, ui);
  if (health.version !== actualVersion || health.service !== 'sfud-ui') throw new Error(`UI health 응답 불일치: ${JSON.stringify(health)}`);
  const html = await (await globalThis.fetch(url)).text();
  const assets = verifyUiAssetPaths(html, entries);
  for (const asset of assets) {
    const response = await globalThis.fetch(new URL(asset, url));
    if (!response.ok || Number(response.headers.get('content-length') ?? '0') === 0) throw new Error(`UI 자산 로딩 실패: ${asset}`);
  }
  await stopUi(ui);
  ui = undefined;

  const databasePath = path.join(dataDirectory, 'sfud.db');
  const databaseBytes = await readFile(databasePath);
  if (databaseBytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') throw new Error('UI가 SQLite 데이터베이스를 생성하지 않았습니다.');
  const packageRequire = createRequire(path.join(packageRoot, 'package.json'));
  const sqlite3 = packageRequire('sqlite3');
  const configuredMode = await sqliteGet(sqlite3, databasePath, 'SELECT mode FROM runtime_mode WHERE id = 1');
  if (configuredMode?.mode !== 'local') throw new Error('홈 설정의 LOCAL=true가 설치된 UI에 적용되지 않았습니다.');
  await sqliteExec(sqlite3, databasePath, 'CREATE TABLE IF NOT EXISTS package_smoke (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO package_smoke(value) VALUES ("sqlite-write-ok");');
  const written = await sqliteGet(sqlite3, databasePath, 'SELECT value FROM package_smoke ORDER BY id DESC LIMIT 1');
  if (written?.value !== 'sqlite-write-ok') throw new Error('SQLite native binding 쓰기 검증 실패');

  const restartPort = await reservePort();
  ui = startUi(path.join(packageRoot, 'dist/cli.js'), temporaryDirectory, ['ui', '--port', String(restartPort), '--no-open'], env);
  const restarted = await waitForUi(`http://127.0.0.1:${restartPort}`, ui);
  if (restarted.version !== actualVersion) throw new Error('SQLite 데이터가 있는 디렉터리에서 UI 재시작이 실패했습니다.');
  const persisted = await sqliteGet(sqlite3, databasePath, 'SELECT value FROM package_smoke ORDER BY id DESC LIMIT 1');
  if (persisted?.value !== 'sqlite-write-ok') throw new Error('SQLite 재시작 후 기록이 보존되지 않았습니다.');
  await stopUi(ui);
  ui = undefined;
  console.log(`package smoke PASS: ${path.basename(tarball)} · sfud ${actualVersion} · Node ${process.version} · home-config/init/no-overwrite/UI/SQLite/cross-cwd-restart`);
} finally {
  if (ui !== undefined) await stopUi(ui).catch(() => {});
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function verifyUiAssets(tarball, entries) {
  const html = await readTarball(tarball, '-xOf', 'package/dist/ui/index.html');
  verifyUiAssetPaths(html, entries);
}

async function verifySourceMaps(tarball, entries) {
  for (const entry of entries.filter((item) => item.endsWith('.map'))) {
    const map = JSON.parse(await readTarball(tarball, '-xOf', entry));
    if (Array.isArray(map.sourcesContent) && map.sourcesContent.some((source) => typeof source === 'string' && source.length > 0)) {
      throw new Error(`소스가 포함된 source map은 배포할 수 없습니다: ${entry}`);
    }
    if (!Array.isArray(map.sources) || map.sources.some((source) => path.isAbsolute(source) || /^[A-Za-z]:[\\/]/u.test(source))) {
      throw new Error(`절대 개발 경로를 포함한 source map: ${entry}`);
    }
  }
}

async function readTarball(tarball, operation, ...entries) {
  // Git Bash의 GNU tar는 D:\\...의 콜론을 원격 호스트 구분자로 해석한다.
  // archive가 있는 디렉터리에서 파일명만 전달하면 GNU/BSD tar 모두 동작한다.
  return await run('tar', [operation, path.basename(tarball), ...entries], path.dirname(tarball));
}

async function createTarball(destination, useExistingBuild) {
  if (useExistingBuild) {
    await Promise.all([access(path.join(root, 'dist/cli.js')), access(path.join(root, 'dist/ui/index.html'))]);
  } else await run('npm', ['run', 'build'], root);
  const pack = JSON.parse(await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination]));
  if (typeof pack?.[0]?.filename !== 'string') throw new Error('npm pack 결과에서 tarball 이름을 확인할 수 없습니다.');
  return path.join(destination, pack[0].filename);
}

async function runNpm(args) { return await run('npx', ['--yes', 'npm@11.20.0', ...args], root); }

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startUi(executable, prefix, args, env) {
  const child = spawn(process.execPath, [executable, ...args], { cwd: prefix, env, stdio: 'ignore' });
  child.once('error', (error) => { child.packageSmokeSpawnError = error; });
  return child;
}

async function waitForUi(url, child) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.packageSmokeSpawnError) throw child.packageSmokeSpawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`UI 프로세스가 조기 종료했습니다: ${child.exitCode ?? child.signalCode}`);
    try {
      const response = await globalThis.fetch(`${url}/api/v1/health`, { signal: globalThis.AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
  }
  throw new Error(`설치된 UI가 시작되지 않았습니다: ${lastError}`);
}

async function stopUi(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = globalThis.setTimeout(() => child.kill('SIGKILL'), 8_000);
  await closed;
  globalThis.clearTimeout(timer);
}

async function sqliteExec(sqlite3, filename, sql) {
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (openError) => {
      if (openError) { reject(openError); return; }
      db.exec(sql, (error) => db.close((closeError) => error ?? closeError ? reject(error ?? closeError) : resolve()));
    });
  });
}

async function sqliteGet(sqlite3, filename, sql) {
  return await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (openError) => {
      if (openError) { reject(openError); return; }
      db.get(sql, (error, row) => db.close((closeError) => error ?? closeError ? reject(error ?? closeError) : resolve(row)));
    });
  });
}

async function run(command, args, cwd, env = selectedNodeEnvironment()) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(' ')} 실패 (${code ?? 'signal'})\n${stderr}`)));
  });
}

function selectedNodeEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === 'LOCAL' || key.toUpperCase().startsWith('SFUD_')) delete environment[key];
  }
  environment.SFUD_CONFIG_DIR = path.join(temporaryDirectory, 'absent-config');
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  environment[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${environment[pathKey] ?? ''}`;
  return environment;
}
