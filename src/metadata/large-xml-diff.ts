import { createHash, type Hash } from 'node:crypto';
import { SfudError } from '../core/errors.js';
import type { XmlChange } from './xml-diff.js';
import { findXmlCollectionPolicy, hasXmlSemanticPolicy } from './xml-semantics.js';
import { readXmlStream } from './xml-stream.js';

const PREVIEW_LENGTH = 500;
const MAX_RETAINED_NODES = 100_000;
const MAX_DEPTH = 128;
const GENERIC_KEYS = ['fullName', 'name', 'field', 'object', 'apexClass', 'userPermission',
  'tab', 'application', 'layout', 'recordType', 'flow', 'profile', 'permissionSet', 'label'];

interface NodeSummary {
  digest: string;
  identity?: string;
  preview: string;
  scalar: boolean;
}
interface Frame {
  name: string;
  xmlPath: string;
  attributes: string;
  children: Map<string, NodeSummary[]>;
  text: Hash;
  nonWhitespace: boolean;
  preview: string;
}
interface DocumentSummary {
  name: string;
  digest: string;
  attributes: string;
  text: string;
  children: Map<string, NodeSummary[]>;
}

// Only one large XML pair at a time, including across concurrent comparison
// jobs. Small component comparisons retain their existing concurrency.
let pending: Promise<void> = Promise.resolve();
export async function compareLargeXml(
  leftPath: string, rightPath: string, metadataType: string, maximumChanges: number,
): Promise<{ equal: boolean; changes: XmlChange[]; truncated: boolean }> {
  const previous = pending;
  let release!: () => void;
  pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const left = await summarizeXml(leftPath, metadataType);
    const right = await summarizeXml(rightPath, metadataType);
    if (left.digest === right.digest) return { equal: true, changes: [], truncated: false };
    const changes: XmlChange[] = [];
    let truncated = false;
    const add = (change: XmlChange, coarse = false) => {
      if (changes.length < maximumChanges) changes.push(change);
      else truncated = true;
      if (coarse) truncated = true;
    };
    if (left.name !== right.name || left.attributes !== right.attributes || left.text !== right.text) {
      add({ kind: 'MODIFIED', path: left.name, before: 'XML 루트 값 또는 속성', after: 'XML 루트 값 또는 속성 변경' }, true);
    }
    for (const name of [...new Set([...left.children.keys(), ...right.children.keys()])].sort()) {
      const a = left.children.get(name) ?? [];
      const b = right.children.get(name) ?? [];
      const xmlPath = `${left.name}.${name}`;
      const keyed = uniqueIdentities(a) && uniqueIdentities(b);
      const leftMap = new Map(a.map((node, index) => [keyed ? node.identity! : String(index), node]));
      const rightMap = new Map(b.map((node, index) => [keyed ? node.identity! : String(index), node]));
      if (keyed && (findXmlCollectionPolicy(metadataType, xmlPath)?.ordered ?? true)
        && a.length === b.length && a.every((node) => rightMap.has(node.identity!))
        && a.some((node, index) => node.identity !== b[index]?.identity)) {
        add({ kind: 'REORDERED', path: `${xmlPath}.$order`, before: '기존 항목 순서', after: '항목 순서 변경' });
      }
      for (const key of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()) {
        const before = leftMap.get(key);
        const after = rightMap.get(key);
        if (before?.digest === after?.digest) continue;
        add({
          kind: before === undefined ? 'ADDED' : after === undefined ? 'REMOVED' : 'MODIFIED',
          path: `${xmlPath}[${key}]`,
          ...(before ? { before: before.preview } : {}),
          ...(after ? { after: after.preview } : {}),
        }, before?.scalar === false || after?.scalar === false
          || (before?.preview.length ?? 0) >= PREVIEW_LENGTH || (after?.preview.length ?? 0) >= PREVIEW_LENGTH);
      }
    }
    return { equal: false, changes, truncated };
  } finally { release(); }
}

async function summarizeXml(filePath: string, metadataType: string): Promise<DocumentSummary> {
  const stack: Frame[] = [];
  let retained = 0;
  let result: DocumentSummary | undefined;
  await readXmlStream(filePath, (parser) => {
    parser.onopentag = (tag) => {
      if (stack.length >= MAX_DEPTH || (stack.length === 0 && result !== undefined)) {
        throw new SfudError('SNAPSHOT_FAILED', '비교 XML의 루트 또는 중첩 깊이 제한(128)을 확인하세요.');
      }
      const parent = stack.at(-1);
      stack.push({ name: tag.name, xmlPath: parent ? `${parent.xmlPath}.${tag.name}` : tag.name,
        attributes: JSON.stringify(Object.entries(tag.attributes).sort(([a], [b]) => a.localeCompare(b))),
        children: new Map(), text: createHash('sha256'), nonWhitespace: false, preview: '' });
    };
    const text = (value: string) => {
      const frame = stack.at(-1);
      if (!frame) return;
      frame.text.update(value);
      if (/\S/u.test(value)) frame.nonWhitespace = true;
      if (frame.preview.length < PREVIEW_LENGTH) frame.preview += value.slice(0, PREVIEW_LENGTH - frame.preview.length);
    };
    parser.ontext = text;
    parser.oncdata = text;
    parser.onclosetag = () => {
      const frame = stack.pop()!;
      const scalar = frame.children.size === 0 && frame.attributes === '[]';
      const textDigest = frame.text.digest('hex');
      // Ignore whitespace-only formatting between children, but preserve leaf values.
      const significantText = scalar || frame.nonWhitespace ? textDigest : '';
      const hash = createHash('sha256').update(JSON.stringify([frame.name, frame.attributes, significantText]));
      for (const name of [...frame.children.keys()].sort()) {
        const nodes = frame.children.get(name)!;
        const policy = findXmlCollectionPolicy(metadataType, `${frame.xmlPath}.${name}`);
        const ordered = policy?.ordered !== false || !uniqueIdentities(nodes);
        const digests = nodes.map((node) => node.digest);
        if (!ordered) digests.sort();
        hash.update(JSON.stringify([name, digests]));
      }
      const digest = hash.digest('hex');
      const identityKeys = findXmlCollectionPolicy(metadataType, frame.xmlPath)?.identityKeys
        ?? (hasXmlSemanticPolicy(metadataType) ? [] : GENERIC_KEYS);
      const identities: string[] = [];
      for (const key of identityKeys) {
        const values = frame.children.get(key);
        if (values?.length !== 1 || !values[0]!.scalar) continue;
        // A long identifier must never collide because its display is truncated.
        const value = values[0]!;
        identities.push(`${key}=${value.preview.length < PREVIEW_LENGTH ? value.preview : value.digest}`);
        if (identityKeys === GENERIC_KEYS) break;
      }
      let preview = scalar ? frame.preview
        : `${frame.attributes === '[]' ? '' : `attributes: ${frame.attributes}; `}${frame.nonWhitespace ? frame.preview : ''}`.slice(0, PREVIEW_LENGTH);
      if (!scalar) for (const [key, values] of frame.children) {
        preview += `${preview ? '; ' : ''}${key}: ${values[0]?.preview ?? ''}`;
        if (preview.length >= PREVIEW_LENGTH) { preview = preview.slice(0, PREVIEW_LENGTH); break; }
      }
      const summary: NodeSummary = { digest, scalar, preview,
        ...(identities.length ? { identity: identities.join('|') } : {}) };
      const parent = stack.at(-1);
      if (!parent) {
        result = { name: frame.name, digest, attributes: frame.attributes, text: significantText, children: frame.children };
      } else {
        for (const children of frame.children.values()) retained -= children.length;
        retained += 1;
        if (retained > MAX_RETAINED_NODES) {
          throw new SfudError('SNAPSHOT_FAILED', '비교 XML의 동시 보관 항목 제한(100,000개)을 초과했습니다. 메타데이터 범위를 나누어 비교하세요.');
        }
        const siblings = parent.children.get(frame.name) ?? [];
        siblings.push(summary);
        parent.children.set(frame.name, siblings);
      }
    };
  });
  if (!result || stack.length) throw new SfudError('SNAPSHOT_FAILED', '비교 XML의 루트가 없습니다.');
  return result;
}

function uniqueIdentities(nodes: NodeSummary[]): boolean {
  return nodes.every((node) => node.identity !== undefined)
    && new Set(nodes.map((node) => node.identity)).size === nodes.length;
}
