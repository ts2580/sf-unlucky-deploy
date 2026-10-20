import { copyFile, link, mkdir, mkdtemp, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SfudError } from '../core/errors.js';
import { listFiles } from '../core/files.js';
import type { MetadataSnapshot } from '../sources/snapshot.js';
import { childMetadataTypes } from './child-metadata-types.js';
import { readXmlStream } from './xml-stream.js';
import { filterPackageChildren } from './package-child-filter.js';

// MDAPI aggregates fields/rules/labels into parent XML files. Project only for
// comparison; the original snapshot and its deployable payload stay immutable.
export async function projectChildMetadata(snapshot: MetadataSnapshot, metadataType?: string | readonly string[], options: {
  excludedKeys?: readonly string[] | undefined; selectedKeys?: readonly string[] | undefined;
} = {}): Promise<{
  snapshot: MetadataSnapshot; excludedKeys: string[]; dispose(): Promise<void>;
}> {
  const types = new Set(typeof metadataType === 'string' ? [metadataType] : metadataType ?? []);
  const rules = childMetadataTypes.filter((entry) => types.has(entry.name));
  const excluded = new Set(options.excludedKeys);
  const excludedTypes = new Set([...excluded].map((key) => key.slice(0, key.indexOf(':'))));
  const exclusionRules = childMetadataTypes.filter((entry) => excludedTypes.has(entry.name));
  if (rules.length === 0 && exclusionRules.length === 0) return { snapshot, excludedKeys: [], async dispose() {} };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sfud-child-compare-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await copyFile(snapshot.manifestPath, path.join(directory, 'package.xml'));
    const files = await listFiles(snapshot.packageRoot);
    const includeParents = rules.length === 0 || [...types].some((type) => !rules.some((rule) => rule.name === type));
    const filteredKeys: string[] = [];
    if (includeParents) {
      for (const file of files) {
        if (file === 'package.xml') continue;
        const output = path.join(directory, file);
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        const matchingRules = exclusionRules.filter((rule) => file.startsWith(`${rule.directory}/`) && file.endsWith(`.${rule.suffix}`));
        if (matchingRules.length > 0) {
          const parentName = file.slice(matchingRules[0]!.directory.length + 1, -matchingRules[0]!.suffix.length - 1);
          const parentSelected = options.selectedKeys === undefined || options.selectedKeys.includes(`${matchingRules[0]!.parent}:${parentName}`);
          const memberKeys = parentSelected ? excluded : new Set([...excluded].filter((key) => options.selectedKeys!.includes(key)));
          filteredKeys.push(...await filterPackageChildren(path.join(snapshot.packageRoot, file), output, parentName, matchingRules, memberKeys));
        } else await link(path.join(snapshot.packageRoot, file), output).catch(() => copyFile(path.join(snapshot.packageRoot, file), output));
      }
    }
    for (const rule of rules) {
      const output = path.join(directory, rule.name);
      await mkdir(output, { recursive: true, mode: 0o700 });
      for (const file of files) {
        if (!file.startsWith(`${rule.directory}/`) || !file.endsWith(`.${rule.suffix}`)) continue;
        const parentName = file.slice(rule.directory.length + 1, -rule.suffix.length - 1);
        await projectFile(path.join(snapshot.packageRoot, file), output, parentName, rule);
      }
    }
    return { excludedKeys: filteredKeys, snapshot: { ...snapshot, packageRoot: directory,
      metadataTypes: [...(includeParents ? snapshot.metadataTypes ?? [] : []), ...rules.map((rule) => ({ xmlName: rule.name, directoryName: rule.name, suffix: 'xml' }))] }, dispose };
  } catch (error) { await dispose(); throw error; }
}

type ProjectionRule = (typeof childMetadataTypes)[number];
type WriteOperation = { kind: 'open' } | { kind: 'text'; value: string } | { kind: 'close'; name: string };

async function projectFile(input: string, output: string, parentName: string, rule: ProjectionRule): Promise<void> {
  let depth = 0;
  let rootSeen = false;
  let selected = false;
  let identity = '';
  let identityCount = 0;
  let readingIdentity = false;
  let handle: FileHandle | undefined;
  // One scratch file reused serially; hard-link publication keeps duplicate
  // identities from overwriting an earlier child.
  const scratch = path.join(output, '.projection-part');
  const operations: WriteOperation[] = [];
  const append = (value: string) => {
    const previous = operations.at(-1);
    if (previous?.kind === 'text') previous.value += value;
    else operations.push({ kind: 'text', value });
  };
  try {
    await readXmlStream(input, (parser) => {
      parser.onopentag = (tag) => {
        depth += 1;
        if (depth > 128) throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터 XML 중첩 깊이 제한(128)을 초과했습니다.');
        const name = localName(tag.name);
        if (depth === 1) {
          if (rootSeen || name !== rule.parent) throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터의 부모 XML을 해석할 수 없습니다.');
          rootSeen = true;
        }
        if (depth === 2 && name === rule.element) {
          selected = true;
          identity = '';
          identityCount = 0;
          operations.push({ kind: 'open' });
        }
        if (!selected) return;
        if (depth === 3 && name === rule.identity) { readingIdentity = true; identityCount += 1; }
        else if (readingIdentity) throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터 이름은 문자열이어야 합니다.');
        const attributes = Object.entries(tag.attributes)
          .filter(([key]) => key !== 'xmlns' && !key.startsWith('xmlns:'))
          .map(([key, value]) => ` ${localName(key)}="${escapeXml(String(value)).replace(/\n/gu, '&#10;').replace(/\t/gu, '&#9;')}"`).join('');
        append(`<${depth === 2 ? rule.name : name}${attributes}>`);
      };
      const text = (value: string) => {
        if (!selected) return;
        if (readingIdentity) {
          identity += value;
          if (identity.length > 240) throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터 이름이 너무 깁니다.');
        }
        append(escapeXml(value));
      };
      parser.ontext = text;
      parser.oncdata = text;
      parser.onclosetag = (name) => {
        if (selected) {
          append(`</${depth === 2 ? rule.name : localName(name)}>`);
          if (depth === 3) readingIdentity = false;
          if (depth === 2) {
            const fullName = rule.ignoreParentName ? identity : `${parentName}.${identity}`;
            if (identityCount !== 1 || identity.length === 0 || !/^[A-Za-z0-9_$.-]+$/u.test(fullName)
              || fullName === '.' || fullName === '..' || fullName.length > 240) {
              throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터 이름 형식이 올바르지 않습니다.');
            }
            operations.push({ kind: 'close', name: fullName });
            selected = false;
          }
        }
        depth -= 1;
      };
    }, async () => {
      // Drain once per input chunk, so slow disk writes back-pressure the reader.
      for (const operation of operations) {
        if (operation.kind === 'open') handle = await open(scratch, 'wx', 0o600);
        else if (operation.kind === 'text') await handle!.writeFile(operation.value);
        else {
          await handle!.close();
          handle = undefined;
          await link(scratch, path.join(output, `${operation.name}.xml`));
          await unlink(scratch);
        }
      }
      operations.length = 0;
    });
    if (!rootSeen || depth !== 0) throw new SfudError('SNAPSHOT_FAILED', '하위 메타데이터 XML 형식이 올바르지 않습니다.');
  } finally { await handle?.close(); }
}

function localName(name: string): string { return name.slice(name.indexOf(':') + 1); }
function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/\r/gu, '&#13;');
}
