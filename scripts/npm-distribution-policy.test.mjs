import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPackedMetadataMatches, assertSafeArchive, verifyUiAssetPaths } from './package-archive-policy.mjs';
import { assertPublicationAllowed, assertSamePublishedArtifact, classifyRegistryLookup } from './npm-publish-policy.mjs';

test('허용된 npm 배포 파일과 UI asset 경로를 승인한다', () => {
  const files = ['package/package.json', 'package/dist/cli.js', 'package/dist/ui/index.html', 'package/dist/ui/assets/app.js', 'package/dist/ui/assets/app.css'];
  assert.doesNotThrow(() => assertSafeArchive(files));
  assert.deepEqual(verifyUiAssetPaths('<script src="/assets/app.js"></script><link href="/assets/app.css">', files), ['/assets/app.js', '/assets/app.css']);
});

test('credential, git, SQLite, development dependency, absolute 및 traversal 경로를 거부한다', () => {
  for (const entry of [
    'package/.env', 'package/.git/config', 'package/.sfud/runs/a', 'package/node_modules/a/index.js',
    'package/store.sqlite3', 'package/store.db-wal', 'package/.sfud-local/data.sqlite',
    'package/dist/secrets.env', 'package/dist/config.json', 'package/.sfud/secrets.env',
    'package/../../outside.txt', '/package/absolute.txt', 'package\\dist\\cli.js',
  ]) assert.throws(() => assertSafeArchive([entry]), undefined, entry);
});

test('UI asset 경로가 tarball 밖으로 벗어나거나 tarball에 없으면 거부한다', () => {
  assert.throws(() => verifyUiAssetPaths('<script src="/assets/../../bad.js"></script><link href="/assets/app.css">', ['package/dist/ui/assets/app.css']));
  assert.throws(() => verifyUiAssetPaths('<script src="/assets/missing.js"></script><link href="/assets/app.css">', ['package/dist/ui/assets/app.css']));
});

test('발행 대상의 package 메타데이터가 checkout과 다른 tarball을 거부한다', () => {
  const source = { name: '@trstyq/sf-unlucky-deploy', version: '0.4.0', private: true, license: undefined,
    publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' }, engines: { node: '>=22.19.0' },
    repository: { type: 'git', url: 'https://github.com/ts2580/sf-unlucky-deploy.git' } };
  assert.doesNotThrow(() => assertPackedMetadataMatches(source, source));
  assert.throws(() => assertPackedMetadataMatches({ ...source, name: 'sf-unlucky-deploy' }, source), /name/u);
  assert.throws(() => assertPackedMetadataMatches({ ...source, version: '0.4.1' }, source), /version/u);
  assert.throws(() => assertPackedMetadataMatches({ ...source, publishConfig: { registry: 'https://evil.example/', access: 'public' } }, source), /publishConfig/u);
});

test('정확한 annotated release ref와 SHA만 발행 대상이 된다', () => {
  const packageJson = {
    name: '@trstyq/sf-unlucky-deploy', version: '0.4.0', private: false, license: 'UNLICENSED',
    publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
  };
  const releaseSha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertPublicationAllowed({ packageJson, releaseTag: 'v0.4.0', workflowRef: 'refs/tags/v0.4.0', workflowSha: releaseSha, releaseSha }));
  for (const overrides of [
    { releaseTag: 'v0.4.1' }, { workflowRef: 'refs/heads/main' }, { workflowSha: 'b'.repeat(40) },
  ]) assert.throws(() => assertPublicationAllowed({ packageJson, releaseTag: 'v0.4.0', workflowRef: 'refs/tags/v0.4.0', workflowSha: releaseSha, releaseSha, ...overrides }));
  assert.throws(() => assertPublicationAllowed({ packageJson: { ...packageJson, private: true }, releaseTag: 'v0.4.0', workflowRef: 'refs/tags/v0.4.0', workflowSha: releaseSha, releaseSha }));
  assert.throws(() => assertPublicationAllowed({ packageJson: { ...packageJson, license: undefined }, releaseTag: 'v0.4.0', workflowRef: 'refs/tags/v0.4.0', workflowSha: releaseSha, releaseSha }));
});

test('registry 404만 미발행으로 보고 네트워크 오류는 중단한다', () => {
  assert.equal(classifyRegistryLookup({ code: 0 }), 'found');
  assert.equal(classifyRegistryLookup({ code: 1, stderr: 'npm error code E404' }), 'not-found');
  assert.throws(() => classifyRegistryLookup({ code: 1, stderr: 'ETIMEDOUT registry.npmjs.org' }), /네트워크/u);
});

test('동일 버전 이미 발행된 tarball은 바이트 일치만 재시도를 허용한다', () => {
  assert.doesNotThrow(() => assertSamePublishedArtifact(Buffer.from('same'), Buffer.from('same')));
  assert.throws(() => assertSamePublishedArtifact(Buffer.from('approved'), Buffer.from('different')), /tarball이 다릅니다/u);
});

test('release manifest create/verify 왕복과 checksum·tag·SHA 오염 거부', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sfud-manifest-test-'));
  const commitSha = 'a'.repeat(40);
  const manifestScript = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url));
  const tarball = 'trstyq-sf-unlucky-deploy-0.4.0.tgz';
  try {
    await mkdir(path.join(directory, 'package'), { recursive: true });
    await writeFile(path.join(directory, 'package/package.json'), JSON.stringify({ name: '@trstyq/sf-unlucky-deploy', version: '0.4.0' }));
    await writeFile(path.join(directory, 'sbom.cdx.json'), '{"bomFormat":"CycloneDX"}\n');
    execFileSync('tar', ['-czf', path.join(directory, tarball), '-C', directory, 'package']);
    execFileSync(process.execPath, [manifestScript, 'create', 'v0.4.0', commitSha, '12345', directory], { cwd: directory });
    const checksumNames = [tarball, 'sbom.cdx.json'];
    const checksumLines = await Promise.all(checksumNames.map(async (name) => {
      const digest = createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex');
      return `${digest}  ${name}`;
    }));
    await writeFile(path.join(directory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
    const verify = (tag = 'v0.4.0', sha = commitSha) => execFileSync(process.execPath,
      [manifestScript, 'verify', tag, sha, '12345', directory], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(verify(), /verified/u);

    // GNU sha256sum's previous ./filename form is accepted, but only for exact asset basenames.
    await writeFile(path.join(directory, 'SHA256SUMS'), `${checksumLines.map((line) => line.replace('  ', '  ./')).join('\n')}\n`);
    assert.match(verify(), /verified/u);
    assert.throws(() => verify('v0.4.1'), /불일치/u);
    assert.throws(() => verify('v0.4.0', 'b'.repeat(40)), /불일치/u);

    await writeFile(path.join(directory, 'SHA256SUMS'), `${'0'.repeat(64)}  ${tarball}\n${checksumLines[1]}\n`);
    assert.throws(() => verify(), /SHA256SUMS/u);
    await writeFile(path.join(directory, 'SHA256SUMS'), `${checksumLines[0]}  ../${tarball}\n${checksumLines[1]}\n`);
    assert.throws(() => verify(), /경로/u);
    const tarballDigest = checksumLines[0].split('  ')[0];
    await writeFile(path.join(directory, 'SHA256SUMS'), `${tarballDigest}  ${tarball}\n${tarballDigest}  ./${tarball}\n${checksumLines[1]}\n`);
    assert.throws(() => verify(), /중복/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
