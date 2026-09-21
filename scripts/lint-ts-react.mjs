import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const inputs = process.argv.slice(2);
const files = (inputs.length === 0 ? ['src', 'ui/src'] : inputs).flatMap((input) =>
  statSync(input).isDirectory() ? collectTypeScriptFiles(input) : [input]);
const diagnostics = [];
const directAsyncHook = /\b(?:React\.)?use(?:Effect|LayoutEffect)\s*\(\s*async\b/gu;

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(directAsyncHook)) {
    const start = match.index ?? 0;
    const line = source.slice(0, start).split('\n').length;
    const column = start - source.lastIndexOf('\n', start - 1);
    diagnostics.push(`${file}:${line}:${column} React hook에는 async 함수를 직접 전달할 수 없습니다. 내부 async 함수를 만들고 void로 호출하세요.`);
  }
}

if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) console.error(diagnostic);
  process.exitCode = 1;
} else {
  console.log(`TS/TSX React async lint: PASS (${files.length} files)`);
}

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
  });
}
