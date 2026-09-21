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
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pendingCr = false;
  const write = (value: string) => {
    if (!value) return;
    if (pendingCr && value.startsWith('\n')) value = value.slice(1);
    pendingCr = value.endsWith('\r');
    parser.write(value.replace(/\r\n?/gu, '\n'));
  };
  for await (const chunk of createReadStream(filePath, { highWaterMark: 32 * 1024 })) {
    let value: string;
    try { value = decoder.decode(chunk as Buffer, { stream: true }); }
    catch { throw new SfudError('SNAPSHOT_FAILED', '비교 XML은 올바른 UTF-8이어야 합니다.'); }
    write(value);
    parser.flush();
    await flush?.();
  }
  let tail: string;
  try { tail = decoder.decode(); }
  catch { throw new SfudError('SNAPSHOT_FAILED', '비교 XML은 올바른 UTF-8이어야 합니다.'); }
  write(tail);
  parser.close();
  await flush?.();
}
