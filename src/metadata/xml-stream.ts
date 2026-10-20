import { createReadStream } from 'node:fs';
import sax, { type SAXParser } from 'sax';
import { SfudError } from '../core/errors.js';

// SAX emits text/CDATA in bounded chunks. Do not accumulate a document DOM.
// Reject DTDs: metadata has no custom entities, nor any reason to resolve them.
export async function readXmlStream(
  filePath: string,
  configure: (parser: SAXParser) => void,
  flush?: () => Promise<void>,
): Promise<void> {
  const options = { trim: false, strictEntities: true };
  const parser = sax.parser(true, options);
  parser.onerror = () => { throw new SfudError('SNAPSHOT_FAILED', '비교 XML 형식이 올바르지 않습니다.'); };
  parser.ondoctype = () => { throw new SfudError('SNAPSHOT_FAILED', '비교 XML의 DTD 선언은 지원하지 않습니다.'); };
  configure(parser);
  for await (const value of normalizedXmlChunks(filePath)) {
    parser.write(value);
    parser.flush();
    await flush?.();
  }
  parser.close();
  await flush?.();
}

// Offsets in this stream are the UTF-16 character positions reported by SAX.
// Preserve all formatting except BOM and line endings, as comparison already does.
export async function* normalizedXmlChunks(filePath: string): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pendingCr = false;
  const normalize = (value: string) => {
    if (!value) return '';
    if (pendingCr && value.startsWith('\n')) value = value.slice(1);
    pendingCr = value.endsWith('\r');
    return value.replace(/\r\n?/gu, '\n');
  };
  for await (const chunk of createReadStream(filePath, { highWaterMark: 32 * 1024 })) {
    let value: string;
    try { value = decoder.decode(chunk as Buffer, { stream: true }); }
    catch { throw new SfudError('SNAPSHOT_FAILED', '비교 XML은 올바른 UTF-8이어야 합니다.'); }
    yield normalize(value);
  }
  let tail: string;
  try { tail = decoder.decode(); }
  catch { throw new SfudError('SNAPSHOT_FAILED', '비교 XML은 올바른 UTF-8이어야 합니다.'); }
  if (tail) yield normalize(tail);
}
