import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import path from 'node:path';

/** Use the fixed npm installer's parser: Windows native tar may reject UTF-8 PAX paths. */
export async function readNpmTarball(npmCli, filename, selectedPath) {
  const tar = createRequire(path.resolve(npmCli))('tar');
  const entries = [];
  const chunks = [];
  let matches = 0;
  await tar.t({
    file: path.resolve(filename), strict: true, noResume: true,
    onReadEntry(entry) {
      entries.push(entry.path);
      if (selectedPath !== undefined && entry.path === selectedPath) {
        matches++;
        entry.on('data', (chunk) => chunks.push(chunk));
      }
      entry.resume();
    },
  });
  if (selectedPath === undefined) return entries;
  if (matches !== 1) throw new Error(`아카이브 항목이 정확히 하나여야 합니다: ${selectedPath} (${matches})`);
  return Buffer.concat(chunks);
}
