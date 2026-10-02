import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { getReleasePolicy } from './release-policy.mjs';

const [tag, mode = 'create'] = process.argv.slice(2);
if (!['create', 'publish'].includes(mode)) throw new Error(`지원하지 않는 릴리즈 검증 모드: ${mode}`);
const { branch, prerelease } = getReleasePolicy(tag);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tagRef = `refs/tags/${tag}`;
const branchRef = `refs/remotes/origin/${branch}`;
if (git('cat-file', '-t', tagRef) !== 'tag') throw new Error('릴리즈는 annotated tag여야 합니다.');
const commit = git('rev-parse', `${tagRef}^{commit}`);
if (git('rev-parse', 'HEAD') !== commit) throw new Error('checkout 커밋과 릴리즈 태그 커밋이 다릅니다.');
if (mode === 'create') {
  if (git('rev-parse', branchRef) !== commit) {
    throw new Error(`${tag} 릴리즈 생성은 최신 ${branch} 커밋에서만 허용됩니다.`);
  }
} else {
  // 원본 Release 검증 이후 브랜치가 전진해도 같은 산출물의 발행·재시도는 허용한다.
  try { git('merge-base', '--is-ancestor', commit, branchRef); }
  catch { throw new Error(`${tag} 발행 커밋은 ${branch} 이력에 포함되어야 합니다.`); }
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `branch=${branch}\nprerelease=${prerelease}\n`);
}
console.log(`release source ok: ${tag} ${commit} (${branch}, ${mode})`);
