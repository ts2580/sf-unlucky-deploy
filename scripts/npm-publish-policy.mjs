import { createHash } from 'node:crypto';

export function assertPublicationAllowed({ packageJson, releaseTag, workflowRef, workflowSha, releaseSha }) {
  if (packageJson.private !== false) throw new Error('package.json private=false가 필요합니다. 라이선스 승인 전 npm 발행 차단 상태입니다.');
  if (typeof packageJson.license !== 'string' || packageJson.license.length === 0) {
    throw new Error('프로젝트 라이선스를 확정하기 전에는 npm 발행할 수 없습니다.');
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseTag)) throw new Error(`릴리즈 태그 형식 오류: ${releaseTag}`);
  if (releaseTag !== `v${packageJson.version}`) throw new Error(`릴리즈 태그와 패키지 버전 불일치: ${releaseTag} != v${packageJson.version}`);
  if (workflowRef !== `refs/tags/${releaseTag}`) throw new Error(`workflow_dispatch 실행 ref는 대상 annotated tag여야 합니다: ${workflowRef}`);
  if (!/^[0-9a-f]{40}$/iu.test(releaseSha) || workflowSha.toLowerCase() !== releaseSha.toLowerCase()) {
    throw new Error('workflow commit SHA와 release manifest의 source SHA가 다릅니다.');
  }
  if (!packageJson.publishConfig || packageJson.publishConfig.registry !== 'https://registry.npmjs.org/'
    || packageJson.publishConfig.access !== 'public') {
    throw new Error('npm public registry 및 public access 설정이 필요합니다.');
  }
}

export function classifyRegistryLookup({ code, stderr = '' }) {
  if (code === 0) return 'found';
  if (/\bE404\b|\b404 Not Found\b/iu.test(stderr)) return 'not-found';
  throw new Error(`npm registry 조회 실패(네트워크/인증 오류 포함): ${stderr.trim() || `exit ${code}`}`);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertSamePublishedArtifact(expectedBytes, registryBytes) {
  const expected = sha256(expectedBytes);
  const actual = sha256(registryBytes);
  if (actual !== expected) throw new Error(`이미 발행된 동일 버전의 tarball이 다릅니다: ${actual} != ${expected}`);
  return expected;
}
