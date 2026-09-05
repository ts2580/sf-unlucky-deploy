import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
if (tag === undefined) {
  throw new Error('검증할 릴리즈 태그가 필요합니다. 예: npm run release:check -- v0.3.0');
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedTag = `v${packageJson.version}`;

if (tag !== expectedTag) {
  throw new Error(`태그 ${tag}와 package.json 버전 ${packageJson.version}이 일치하지 않습니다. 예상 태그: ${expectedTag}`);
}

process.stdout.write(`release version ok: ${expectedTag}\n`);
