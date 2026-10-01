import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertPublicationAllowed, assertSamePublishedArtifact, classifyRegistryLookup } from './npm-publish-policy.mjs';

const [tarballPath, releaseTag] = process.argv.slice(2);
if (!tarballPath || !releaseTag) throw new Error('사용법: node scripts/publish-npm.mjs <verified-tarball> <release-tag>');
const root = process.cwd();
const registry = 'https://registry.npmjs.org/';
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tarball = path.resolve(root, tarballPath);
const npmConfig = await npm(['config', 'get', 'registry']);
if (new URL(npmConfig.trim()).href !== new URL(registry).href) throw new Error(`npm registry 불일치: ${npmConfig.trim()}`);
const lookup = await npmResult(['view', `${packageJson.name}@${packageJson.version}`, 'dist.tarball', '--json', `--registry=${registry}`]);
const state = classifyRegistryLookup({ code: lookup.code, stderr: lookup.stderr });
if (state === 'found') {
  await verifyRegistryTarball(lookup.stdout, await readFile(tarball));
  console.log(`${packageJson.name}@${packageJson.version}는 동일한 tarball로 이미 발행되어 있습니다. 발행 재시도 건너뜀.`);
} else {
  assertPublicationAllowed({
    packageJson,
    releaseTag,
    workflowRef: process.env.GITHUB_REF ?? '',
    workflowSha: process.env.GITHUB_SHA ?? '',
    releaseSha: process.env.RELEASE_SOURCE_SHA ?? '',
  });
  await npm(['publish', tarball, '--access', 'public', '--tag', 'next', '--ignore-scripts', `--registry=${registry}`]);
  const published = await npmResult(['view', `${packageJson.name}@${packageJson.version}`, 'dist.tarball', '--json', `--registry=${registry}`]);
  if (classifyRegistryLookup({ code: published.code, stderr: published.stderr }) !== 'found') {
    throw new Error('npm publish 응답 뒤 registry에서 같은 버전을 찾을 수 없습니다. 재발행 전에 registry 상태를 확인하세요.');
  }
  await verifyRegistryTarball(published.stdout, await readFile(tarball));
  console.log(`${packageJson.name}@${packageJson.version} registry tarball 바이트 검증 완료. dist-tag=next; latest 이동은 소유자의 별도 인증 작업입니다.`);
}

async function verifyRegistryTarball(viewOutput, approvedBytes) {
  let registryTarballUrl;
  try { registryTarballUrl = JSON.parse(viewOutput); }
  catch { throw new Error('registry npm view dist.tarball 응답을 JSON으로 해석할 수 없습니다.'); }
  if (typeof registryTarballUrl !== 'string' || !registryTarballUrl.startsWith(registry)) {
    throw new Error(`registry가 반환한 tarball URL이 npmjs registry가 아닙니다: ${registryTarballUrl}`);
  }
  const response = await globalThis.fetch(registryTarballUrl, { redirect: 'follow', signal: globalThis.AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`registry tarball 다운로드 실패: HTTP ${response.status}`);
  assertSamePublishedArtifact(approvedBytes, Buffer.from(await response.arrayBuffer()));
}

async function npm(args) {
  const result = await npmResult(args);
  if (result.code !== 0) throw new Error(`npm ${args.join(' ')} 실패 (${result.code})\n${result.stderr}`);
  return result.stdout;
}

async function npmResult(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'npm@11.20.0', ...args], {
      cwd: root,
      env: { ...process.env, NPM_CONFIG_REGISTRY: registry },
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
