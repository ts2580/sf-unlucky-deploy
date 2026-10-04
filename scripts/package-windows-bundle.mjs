import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WINDOWS_BUNDLE as policy, assertWindowsBundleArchive, assertWindowsX64Binary } from './windows-bundle-policy.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 러너에서 패키징해야 합니다.');
const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument || !process.env.SFUD_SMOKE_NPM_CLI) {
  throw new Error(`사용법: SFUD_SMOKE_NPM_CLI=<npm-cli.js> node scripts/package-windows-bundle.mjs <${policy.baseVersion}-tarball> <output>`);
}
const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'sfud-win-bundle-'));
const stage = path.join(temporary, 'package');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const npm = (args, cwd) => run(process.execPath, [process.env.SFUD_SMOKE_NPM_CLI, ...args], cwd);
try {
  if (digest(await readFile(source)) !== policy.sourceSha256) throw new Error(`${policy.baseVersion} 원본 tarball SHA-256 불일치`);
  await mkdir(destination, { recursive: true });
  await run('tar', ['-xf', path.basename(source), '-C', temporary], path.dirname(source));
  const packageJson = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
  if (packageJson.name !== policy.name || packageJson.version !== policy.baseVersion) throw new Error(`${policy.baseVersion} 원본 패키지 식별 오류`);
  // 검증된 원본 shrinkwrap으로 실행 의존성만 설치한다. native 설치 스크립트는 실행하지 않는다.
  await npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  const response = await globalThis.fetch(policy.sqliteUrl, { signal: globalThis.AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`SQLite binary 다운로드 실패: ${response.status}`);
  const sqliteArchive = Buffer.from(await response.arrayBuffer());
  if (digest(sqliteArchive) !== policy.sqliteSha256) throw new Error('공식 SQLite binary archive SHA-256 불일치');
  const sqliteArchivePath = path.join(temporary, 'sqlite-win32-x64.tar.gz');
  await writeFile(sqliteArchivePath, sqliteArchive);
  const sqliteRoot = path.join(stage, 'node_modules', 'sqlite3');
  await run('tar', ['-xf', path.basename(sqliteArchivePath), '-C', sqliteRoot], temporary);
  const binary = await readFile(path.join(sqliteRoot, 'build', 'Release', 'node_sqlite3.node'));
  assertWindowsX64Binary(binary);

  const lock = JSON.parse(await readFile(path.join(stage, 'npm-shrinkwrap.json'), 'utf8'));
  const dependencies = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (relative === '') continue;
    const metadataPath = path.join(stage, relative, 'package.json');
    try { await access(metadataPath); } catch { delete lock.packages[relative]; continue; }
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (relative === 'node_modules/sqlite3') {
      if (metadata.version !== policy.sqliteVersion) throw new Error('SQLite package version 불일치');
      metadata.files = [...(metadata.files ?? []), 'build/Release/node_sqlite3.node'];
    }
    // 이미 설치·동봉된 파일만 사용한다. npm 기본 node-gyp 동작도 비활성화한다.
    delete metadata.scripts;
    metadata.gypfile = false;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    entry.inBundle = true;
    delete entry.hasInstallScript;
    dependencies.push({ path: relative, name: metadata.name, version: metadata.version, license: metadata.license ?? null });
  }
  packageJson.version = policy.version;
  packageJson.description += ' (Windows x64 SQLite 포함 배포본)';
  packageJson.os = ['win32'];
  packageJson.cpu = ['x64'];
  packageJson.bundleDependencies = Object.keys(packageJson.dependencies);
  packageJson.files = ['dist/', 'README.md', 'WINDOWS-README.md', 'THIRD_PARTY_NOTICES.md', 'npm-shrinkwrap.json', 'windows-bundle-manifest.json'];
  packageJson.publishConfig = { ...packageJson.publishConfig, tag: 'win32-x64' };
  for (const field of ['scripts', 'devDependencies', 'allowScripts']) delete packageJson[field];
  lock.version = policy.version;
  lock.packages[''] = { ...lock.packages[''], version: policy.version, os: ['win32'], cpu: ['x64'], bundleDependencies: packageJson.bundleDependencies };
  delete lock.packages[''].devDependencies;
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(path.join(stage, 'npm-shrinkwrap.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await rm(path.join(stage, 'node_modules', '.package-lock.json'), { force: true });
  const manifest = { schemaVersion: 1, package: policy.name, version: policy.version, sourceVersion: policy.baseVersion,
    sourceCommit: policy.sourceCommit, sourceTarballSha256: policy.sourceSha256,
    builderCommit: process.env.GITHUB_SHA ?? null, buildRunId: process.env.GITHUB_RUN_ID ?? null,
    platform: 'win32', arch: 'x64', sqlite: { version: policy.sqliteVersion, archiveUrl: policy.sqliteUrl,
      archiveSha256: policy.sqliteSha256, binarySha256: digest(binary) }, dependencies };
  const instructions = `# ${policy.baseVersion} Windows x64 SQLite 포함 패키지\n\n원본 ${policy.baseVersion} 실행 코드와 UI를 그대로 사용합니다. 패키지 버전은 ${policy.version}, sfud --version 출력은 ${policy.baseVersion}입니다.\n\nNode.js 22.19.0 이상(x64), Git, Salesforce CLI v2는 별도 설치합니다. Windows ARM64용 패키지가 아닙니다.\n\n## npm 설치\n\n\`npm install -g --ignore-scripts @trstyq/sf-unlucky-deploy@win32-x64\`\n\n## 파일 전달 후 오프라인 설치\n\n\`npm install -g --offline --ignore-scripts ./trstyq-sf-unlucky-deploy-${policy.version}.tgz\`\n\n\`sfud --version\`\n\n\`sfud ui\`\n\nSQLite native binding과 실행 의존성을 포함하므로 설치 중 GitHub 다운로드나 C++ 빌드가 필요하지 않습니다. 일반 ${policy.baseVersion}와 같은 패키지 이름·sfud 명령을 사용하므로 기존 전역 설치를 대체합니다. 기존 사용자 설정과 데이터는 패키지 밖에 보존됩니다.\n`;
  await writeFile(path.join(stage, 'windows-bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(stage, 'WINDOWS-README.md'), instructions);
  const packed = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], stage));
  const tarball = packed[0].filename;
  const entries = (await run('tar', ['-tf', tarball], destination)).trim().split(/\r?\n/u);
  assertWindowsBundleArchive(entries);
  const sbom = await npm(['sbom', '--omit=dev', '--sbom-format=cyclonedx', '--sbom-type=application'], stage);
  JSON.parse(sbom);
  const assetPrefix = `windows-x64-${policy.baseVersion}`;
  const files = { [`${assetPrefix}-manifest.json`]: JSON.stringify(manifest, null, 2) + '\n',
    [`${assetPrefix}-sbom.cdx.json`]: sbom, [`${assetPrefix}-README.md`]: instructions };
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(destination, name), contents);
  const checksums = [];
  for (const name of [tarball, ...Object.keys(files)]) checksums.push(`${digest(await readFile(path.join(destination, name)))}  ${name}`);
  await writeFile(path.join(destination, `${assetPrefix}-SHA256SUMS`), checksums.join('\n') + '\n');
  console.log(`Windows bundle created: ${tarball} (${dependencies.length} bundled packages)`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}

async function run(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} ${args.join(' ')} (${code})\n${stderr}`)));
  });
}
