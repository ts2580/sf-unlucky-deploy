import { copyFile, link, open } from 'node:fs/promises';
import { SfudError } from '../core/errors.js';
import type { childMetadataTypes } from './child-metadata-types.js';
import { normalizedXmlChunks, readXmlStream } from './xml-stream.js';

type Rule = (typeof childMetadataTypes)[number];

/** Remove only selected embedded members from a comparison copy, never its source. */
export async function filterPackageChildren(
  input: string, output: string, parentName: string, rules: readonly Rule[], excluded: ReadonlySet<string>,
): Promise<string[]> {
  const ranges: Array<{ start: number; end: number; key: string }> = [];
  let depth = 0;
  let rootSeen = false;
  let rule: Rule | undefined;
  let start = 0;
  let separatorStart = 0;
  let whitespaceSeparator = true;
  let identity = '';
  let identityCount = 0;
  let readingIdentity = false;
  await readXmlStream(input, (parser) => {
    parser.onopentag = (tag) => {
      depth += 1;
      if (depth > 128) throw invalidMember();
      const name = tag.name.slice(tag.name.indexOf(':') + 1);
      if (depth === 1) {
        if (rootSeen || name !== rules[0]!.parent) throw invalidMember();
        rootSeen = true;
        separatorStart = parser.position;
      }
      if (depth === 2) {
        rule = rules.find((candidate) => candidate.element === name);
        start = whitespaceSeparator ? separatorStart : parser.startTagPosition - 1;
        identity = ''; identityCount = 0;
      }
      if (rule && depth === 3 && name === rule.identity) { readingIdentity = true; identityCount += 1; }
      else if (readingIdentity) throw invalidMember();
    };
    const text = (value: string) => {
      if (depth === 1 && value.trim() !== '') whitespaceSeparator = false;
      if (readingIdentity) { identity += value; if (identity.length > 240) throw invalidMember(); }
    };
    parser.ontext = text;
    parser.oncdata = (value) => { if (depth === 1) whitespaceSeparator = false; text(value); };
    parser.oncomment = parser.onprocessinginstruction = () => { if (depth === 1) whitespaceSeparator = false; };
    parser.onclosetag = () => {
      if (depth === 3) readingIdentity = false;
      if (depth === 2) {
        if (rule) {
          if (identityCount !== 1 || !/^[A-Za-z0-9_$.-]+$/u.test(identity)) throw invalidMember();
          const fullName = rule.ignoreParentName ? identity : `${parentName}.${identity}`;
          const key = `${rule.name}:${fullName}`;
          if (excluded.has(key)) ranges.push({ start, end: parser.position, key });
        }
        rule = undefined;
        separatorStart = parser.position;
        whitespaceSeparator = true;
      }
      depth -= 1;
    };
  });
  if (!rootSeen || depth !== 0) throw invalidMember();
  if (ranges.length === 0) {
    await link(input, output).catch(() => copyFile(input, output));
    return [];
  }
  // A second streaming pass retains the exact text outside removed ranges,
  // including attributes, comments and formatting differences used by strict mode.
  const handle = await open(output, 'wx', 0o600);
  try {
    let position = 0;
    let index = 0;
    for await (const chunk of normalizedXmlChunks(input)) {
      const end = position + chunk.length;
      let cursor = position;
      while (index < ranges.length && ranges[index]!.start < end) {
        const range = ranges[index]!;
        if (range.start > cursor) await handle.writeFile(chunk.slice(cursor - position, range.start - position));
        cursor = Math.min(end, range.end);
        if (range.end > end) break;
        index += 1;
      }
      if (cursor < end) await handle.writeFile(chunk.slice(cursor - position));
      position = end;
    }
  } finally { await handle.close(); }
  return ranges.map((range) => range.key);
}

function invalidMember(): SfudError {
  return new SfudError('SNAPSHOT_FAILED', '제외할 패키지 하위 메타데이터를 확인하지 못했습니다.');
}
