import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [mode, tag, commitSha, runId, directory = 'release'] = process.argv.slice(2);
if (!['create', 'verify'].includes(mode) || !tag || !commitSha || !runId) {
  throw new Error('사용법: node scripts/release-manifest.mjs <create|verify> <tag> <commit-sha> <run-id> [directory]');
}
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error(`잘못된 릴리즈 태그: ${tag}`);
if (!/^[0-9a-f]{40}$/iu.test(commitSha)) throw new Error('commit SHA는 40자리여야 합니다.');
if (!/^\d+$/u.test(runId)) throw new Error('GitHub Actions run ID가 올바르지 않습니다.');

const files = await readdir(directory);
const tarballs = files.filter((file) => /^trstyq-sf-unlucky-deploy-[0-9A-Za-z.-]+\.tgz$/u.test(file));
if (tarballs.length !== 1) throw new Error(`릴리즈 디렉터리에 sf-unlucky-deploy tarball이 정확히 하나 있어야 합니다: ${tarballs.length}`);
for (const required of ['sbom.cdx.json']) if (!files.includes(required)) throw new Error(`필수 릴리즈 파일 누락: ${required}`);
const tarball = tarballs[0];
const packageJson = JSON.parse(await run('tar', ['-xOf', path.join(directory, tarball), 'package/package.json']));
if (tag !== `v${packageJson.version}` || tarball !== `${packageJson.name.replace(/^@/u, "").replace("/", "-")}-${packageJson.version}.tgz`) {
  throw new Error(`태그·tarball·패키지 버전 불일치: ${tag}, ${tarball}, ${packageJson.name}@${packageJson.version}`);
}
const checksums = {};
for (const file of [tarball, 'sbom.cdx.json']) checksums[file] = await hash(path.join(directory, file));
const manifest = { schemaVersion: 1, repository: 'ts2580/sf-unlucky-deploy', tag, commitSha: commitSha.toLowerCase(), runId, package: { name: packageJson.name, version: packageJson.version }, files: checksums };
const manifestPath = path.join(directory, 'release-manifest.json');
if (mode === 'create') {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`release manifest created: ${manifestPath}`);
} else {
  const actual = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const key of ['schemaVersion', 'repository', 'tag', 'commitSha', 'runId']) {
    if (actual[key] !== manifest[key]) throw new Error(`manifest ${key} 불일치: ${actual[key]} != ${manifest[key]}`);
  }
  if (JSON.stringify(actual.package) !== JSON.stringify(manifest.package)) throw new Error('manifest package name/version 불일치');
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files)) throw new Error('manifest 파일 해시가 다운로드 산출물과 다릅니다.');
  const checksumFile = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  const checksumEntries = checksumFile.trim().split(/\r?\n/u).map((line) => line.match(/^([a-f0-9]{64}) {2}((?:\.\/)?(?:trstyq-sf-unlucky-deploy-[0-9A-Za-z.-]+\.tgz|sbom\.cdx\.json))$/u));
  const parsed = new Map();
  for (const entry of checksumEntries) {
    if (entry === null) throw new Error('SHA256SUMS 형식 또는 파일 경로가 잘못되었습니다.');
    const name = entry[2].replace(/^\.\//u, '');
    if (parsed.has(name)) throw new Error(`SHA256SUMS에 중복 파일 항목이 있습니다: ${name}`);
    parsed.set(name, entry[1]);
  }
  if (parsed.size !== 2 || parsed.get(tarball) !== checksums[tarball] || parsed.get('sbom.cdx.json') !== checksums['sbom.cdx.json']) {
    throw new Error('SHA256SUMS 항목이 manifest 산출물과 일치하지 않습니다.');
  }
  console.log(`release manifest verified: ${tag} ${commitSha}`);
}

async function hash(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} 실패 (${code}): ${stderr}`)));
  });
}
