import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Keep large-file comparison bounded in memory, with the same BOM/newline
// normalization as the detailed diff. Undefined means non-text input.
export async function normalizedTextHash(filePath: string): Promise<string | undefined> {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let first = true;
  let pendingCr = false;
  const update = (text: string) => {
    if (text.length === 0) return;
    if (first) { text = text.replace(/^\uFEFF/u, ''); first = false; }
    if (pendingCr && text.startsWith('\n')) text = text.slice(1);
    pendingCr = text.endsWith('\r');
    hash.update(text.replace(/\r\n?/gu, '\n'));
  };
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    if (bytes.includes(0)) return undefined;
    let text: string;
    try { text = decoder.decode(bytes, { stream: true }); }
    catch { return undefined; }
    update(text);
  }
  let final: string;
  try { final = decoder.decode(); }
  catch { return undefined; }
  update(final);
  return hash.digest('hex');
}
