import { readFileSync } from 'node:fs';
import { getReleasePolicy } from './release-policy.mjs';

const tag = process.argv[2];
if (tag === undefined) {
  throw new Error('검증할 릴리즈 태그가 필요합니다. 예: npm run release:check -- v0.4.0');
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const shrinkwrap = JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
const program = readFileSync(new URL('../src/program.ts', import.meta.url), 'utf8');
const cliVersion = program.match(/export const CLI_VERSION = '([^']+)'/u)?.[1];
const expectedTag = `v${packageJson.version}`;

getReleasePolicy(tag);
if (tag !== expectedTag) {
  throw new Error(`태그 ${tag}와 package.json 버전 ${packageJson.version}이 일치하지 않습니다. 예상 태그: ${expectedTag}`);
}
if (packageJson.version !== packageLock.version || packageJson.version !== shrinkwrap.version
  || packageJson.version !== packageLock.packages?.['']?.version
  || packageJson.version !== shrinkwrap.packages?.['']?.version) {
  throw new Error('package.json, package-lock.json, npm-shrinkwrap.json root 버전이 모두 일치해야 합니다.');
}
if (cliVersion !== packageJson.version) {
  throw new Error(`CLI_VERSION ${cliVersion ?? '(확인 불가)'}와 package.json 버전 ${packageJson.version}이 일치하지 않습니다.`);
}
if (packageJson.engines?.node !== '>=22.19.0') {
  throw new Error('npm 배포 지원 Node 기준은 engines.node >=22.19.0이어야 합니다.');
}

process.stdout.write(`release version ok: ${expectedTag}\n`);
