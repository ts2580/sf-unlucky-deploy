import { XMLParser } from 'fast-xml-parser';

import { findXmlCollectionPolicy, hasXmlSemanticPolicy } from './xml-semantics.js';

export type XmlChangeKind = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'REORDERED';

export interface XmlChange {
  kind: XmlChangeKind;
  path: string;
  before?: string;
  after?: string;
}

const IDENTITY_KEYS = [
  'fullName',
  'name',
  'field',
  'object',
  'apexClass',
  'userPermission',
  'tab',
  'application',
  'layout',
  'recordType',
  'flow',
  'profile',
  'permissionSet',
  'label',
] as const;

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

export interface CompareXmlOptions {
  metadataType?: string;
}

export function compareXml(
  leftXml: string,
  rightXml: string,
  options: CompareXmlOptions = {},
): XmlChange[] {
  const left = removeFormattingWhitespace(parser.parse(leftXml) as unknown);
  const right = removeFormattingWhitespace(parser.parse(rightXml) as unknown);
  return diffValue(left, right, '', options.metadataType);
}

function removeFormattingWhitespace(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeFormattingWhitespace);
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '#text' && typeof child === 'string' && child.trim().length === 0) {
      continue;
    }
    normalized[key] = removeFormattingWhitespace(child);
  }
  return normalized;
}

function diffValue(
  left: unknown,
  right: unknown,
  currentPath: string,
  metadataType: string | undefined,
): XmlChange[] {
  if (Object.is(left, right)) {
    return [];
  }

  if (left === undefined) {
    return [{ kind: 'ADDED', path: currentPath, after: formatValue(right) }];
  }
  if (right === undefined) {
    return [{ kind: 'REMOVED', path: currentPath, before: formatValue(left) }];
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return diffArray(left, right, currentPath, metadataType);
  }

  if (isRecord(left) && isRecord(right)) {
    const leftIdentity = findIdentity(left);
    const rightIdentity = findIdentity(right);
    const objectPath =
      currentPath.includes('.') &&
      !currentPath.endsWith(']') &&
      leftIdentity !== undefined &&
      leftIdentity === rightIdentity
        ? `${currentPath}[${leftIdentity}]`
        : currentPath;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) =>
      a.localeCompare(b),
    );
    return keys.flatMap((key) =>
      diffValue(left[key], right[key], appendPath(objectPath, key), metadataType));
  }

  return [
    {
      kind: 'MODIFIED',
      path: currentPath,
      before: formatValue(left),
      after: formatValue(right),
    },
  ];
}

function diffArray(
  left: unknown[],
  right: unknown[],
  currentPath: string,
  metadataType: string | undefined,
): XmlChange[] {
  const collectionPolicy = findXmlCollectionPolicy(metadataType, currentPath);
  const identityKeys = collectionPolicy?.identityKeys
    ?? (hasXmlSemanticPolicy(metadataType) ? [] : IDENTITY_KEYS);
  const ordered = collectionPolicy?.ordered ?? true;
  const leftIdentities = left.map((value) => findIdentity(value, identityKeys));
  const rightIdentities = right.map((value) => findIdentity(value, identityKeys));
  const canMatchByIdentity =
    leftIdentities.every((identity) => identity !== undefined) &&
    rightIdentities.every((identity) => identity !== undefined) &&
    new Set(leftIdentities).size === leftIdentities.length &&
    new Set(rightIdentities).size === rightIdentities.length;

  if (!canMatchByIdentity) {
    const changes: XmlChange[] = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      changes.push(...diffValue(left[index], right[index], `${currentPath}[${index}]`, metadataType));
    }
    return changes;
  }

  const leftByIdentity = new Map(left.map((value, index) => [leftIdentities[index]!, value]));
  const rightByIdentity = new Map(right.map((value, index) => [rightIdentities[index]!, value]));
  const identities = [...new Set([...leftIdentities, ...rightIdentities])].sort((a, b) =>
    a!.localeCompare(b!),
  ) as string[];
  const changes: XmlChange[] = [];

  if (
    ordered &&
    leftIdentities.length === rightIdentities.length &&
    leftIdentities.every((identity) => rightByIdentity.has(identity!)) &&
    leftIdentities.some((identity, index) => identity !== rightIdentities[index])
  ) {
    changes.push({
      kind: 'REORDERED',
      path: `${currentPath}.$order`,
      before: leftIdentities.join(', '),
      after: rightIdentities.join(', '),
    });
  }

  for (const identity of identities) {
    changes.push(
      ...diffValue(
        leftByIdentity.get(identity),
        rightByIdentity.get(identity),
        `${currentPath}[${identity}]`,
        metadataType,
      ),
    );
  }

  return changes;
}

function findIdentity(
  value: unknown,
  identityKeys: readonly string[] = IDENTITY_KEYS,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const values: string[] = [];
  for (const key of identityKeys) {
    const candidate = value[key];
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      values.push(`${key}=${String(candidate)}`);
      if (identityKeys === IDENTITY_KEYS) return values[0];
    }
  }

  return values.length === 0 ? undefined : values.join('|');
}

function appendPath(currentPath: string, key: string): string {
  return currentPath.length === 0 ? key : `${currentPath}.${key}`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return String(value);
  }
  return serialized.length > 500 ? `${serialized.slice(0, 497)}...` : serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
