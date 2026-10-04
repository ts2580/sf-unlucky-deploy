import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const inputs = process.argv.slice(2);
const files = (inputs.length === 0 ? ['src', 'ui/src'] : inputs).flatMap((input) =>
  statSync(input).isDirectory() ? collectTypeScriptFiles(input) : [input]);
const diagnostics = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const parsed = parse(source, { sourceType: 'module', sourceFilename: file,
    plugins: ['typescript', ...(file.endsWith('.tsx') ? ['jsx'] : [])] });
  visit(parsed);

  function visit(node) {
    if (node?.type === 'CallExpression' && isEffectCall(node.callee) && node.arguments.length > 0) {
      const callback = node.arguments[0];
      if ((callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')
        && callback.async) {
        diagnostics.push(`${file}:${callback.loc.start.line}:${callback.loc.start.column + 1} React hook에는 async 함수를 직접 전달할 수 없습니다. 내부 async 함수를 만들고 void로 호출하세요.`);
      }
    }
    for (const value of Object.values(node ?? {})) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child);
      } else if (value?.type) visit(value);
    }
  }
}

if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) console.error(diagnostic);
  process.exitCode = 1;
} else {
  console.log(`TS/TSX React async hook AST lint: PASS (${files.length} files)`);
}

function isEffectCall(callee) {
  const name = callee?.type === 'Identifier' ? callee.name
    : callee?.type === 'MemberExpression' && callee.object?.type === 'Identifier'
      && callee.object.name === 'React' && callee.property?.type === 'Identifier' ? callee.property.name : undefined;
  return name === 'useEffect' || name === 'useLayoutEffect';
}

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
    return /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
  });
}
