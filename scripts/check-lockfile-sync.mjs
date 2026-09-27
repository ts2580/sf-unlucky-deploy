import { readFileSync } from 'node:fs';

const IGNORED_FIELDS = new Set(['resolved', 'integrity']);

function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !IGNORED_FIELDS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }

  return value;
}

function firstDifference(left, right, path = '$') {
  if (Object.is(left, right)) {
    return undefined;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${path}.length (${left.length} != ${right.length})`;
    }
    return left.map((entry, index) => firstDifference(entry, right[index], `${path}[${index}]`)).find(Boolean);
  }

  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      if (!(key in left) || !(key in right)) {
        return `${path}.${key} (${key in left ? 'package-lock.json에만 있음' : 'npm-shrinkwrap.json에만 있음'})`;
      }
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference) {
        return difference;
      }
    }
    return undefined;
  }

  return `${path} (${JSON.stringify(left)} != ${JSON.stringify(right)})`;
}

const packageLock = normalize(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
const shrinkwrap = normalize(JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8')));
const difference = firstDifference(packageLock, shrinkwrap);

if (difference) {
  console.error(`잠금 파일 dependency graph 불일치: ${difference}`);
  process.exitCode = 1;
} else {
  console.log('잠금 파일 dependency graph 동기화: PASS');
}
