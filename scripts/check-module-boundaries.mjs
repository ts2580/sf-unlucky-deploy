import { readdirSync, readFileSync } from 'node:fs';
import { checkBoundaries } from './module-boundaries.mjs';

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? collect(file) : /\.tsx?$/u.test(file) ? [file] : [];
  });
}
const files = new Map(['src', 'ui/src'].flatMap(collect).map((file) => [file, readFileSync(file, 'utf8')]));
const diagnostics = checkBoundaries(files);
if (diagnostics.length) {
  for (const diagnostic of diagnostics) console.error(diagnostic);
  process.exitCode = 1;
} else console.log(`Module boundaries: PASS (${files.size} files, no exceptions)`);
