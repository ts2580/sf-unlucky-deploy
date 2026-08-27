import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createTwoFilesPatch } from 'diff';

import { SfudError } from '../core/errors.js';
import type { MetadataSnapshot } from '../sources/snapshot.js';
import { resolveMetadataComponents, type MetadataComponent } from './component-resolver.js';
import { compareXml, type XmlChange } from './xml-diff.js';

export type DifferenceStatus = 'ADDED' | 'REMOVED' | 'MODIFIED' | 'IDENTICAL';
export type FileKind = 'xml' | 'text' | 'binary';

export interface FileDifference {
  path: string;
  status: DifferenceStatus;
  kind: FileKind;
  leftSha256?: string;
  rightSha256?: string;
  leftSize?: number;
  rightSize?: number;
  xmlChanges?: XmlChange[];
  unifiedDiff?: string;
}

export interface ComponentDifference {
  key: string;
  type: string;
  fullName: string;
  status: DifferenceStatus;
  files: FileDifference[];
}

export interface ComparisonSummary {
  added: number;
  removed: number;
  modified: number;
  identical: number;
  total: number;
  different: number;
}

export interface ComparisonResult {
  generatedAt: string;
  strict: boolean;
  left: SnapshotReference;
  right: SnapshotReference;
  summary: ComparisonSummary;
  components: ComponentDifference[];
  warnings: string[];
}

interface SnapshotReference {
  displayName: string;
  kind: 'org' | 'local';
  manifestSha256: string;
  payloadSha256: string;
}

export interface CompareOptions {
  strict?: boolean;
}

export async function compareSnapshots(
  left: MetadataSnapshot,
  right: MetadataSnapshot,
  options: CompareOptions = {},
): Promise<ComparisonResult> {
  if (left.manifestSha256 !== right.manifestSha256) {
    throw new SfudError(
      'INVALID_ARGUMENT',
      '동일한 manifest로 생성되지 않은 snapshot은 비교할 수 없습니다.',
    );
  }

  const leftComponents = await resolveMetadataComponents(left.packageRoot, left.metadataTypes);
  const rightComponents = await resolveMetadataComponents(right.packageRoot, right.metadataTypes);
  const keys = [...new Set([...leftComponents.keys(), ...rightComponents.keys()])].sort((a, b) =>
    a.localeCompare(b),
  );
  const components: ComponentDifference[] = [];

  for (const key of keys) {
    const leftComponent = leftComponents.get(key);
    const rightComponent = rightComponents.get(key);
    components.push(
      await compareComponent(
        left.packageRoot,
        right.packageRoot,
        leftComponent,
        rightComponent,
        options.strict ?? false,
      ),
    );
  }

  const summary = summarize(components);
  const hasPermissionMetadata = components.some(
    (component) => component.type === 'Profile' || component.type === 'PermissionSet',
  );

  return {
    generatedAt: new Date().toISOString(),
    strict: options.strict ?? false,
    left: snapshotReference(left),
    right: snapshotReference(right),
    summary,
    components,
    warnings: hasPermissionMetadata
      ? ['Profile과 PermissionSet 결과는 동일 manifest에 포함된 메타데이터 범위 안에서만 유효합니다.']
      : [],
  };
}

async function compareComponent(
  leftRoot: string,
  rightRoot: string,
  left: MetadataComponent | undefined,
  right: MetadataComponent | undefined,
  strict: boolean,
): Promise<ComponentDifference> {
  const descriptor = left ?? right;
  if (!descriptor) {
    throw new SfudError('SNAPSHOT_FAILED', '비교할 메타데이터 컴포넌트를 해석할 수 없습니다.');
  }

  if (!left) {
    return {
      key: descriptor.key,
      type: descriptor.type,
      fullName: descriptor.fullName,
      status: 'ADDED',
      files: await describeOneSidedFiles(rightRoot, descriptor.files, 'ADDED'),
    };
  }

  if (!right) {
    return {
      key: descriptor.key,
      type: descriptor.type,
      fullName: descriptor.fullName,
      status: 'REMOVED',
      files: await describeOneSidedFiles(leftRoot, descriptor.files, 'REMOVED'),
    };
  }

  const filePaths = [...new Set([...left.files, ...right.files])].sort((a, b) => a.localeCompare(b));
  const files: FileDifference[] = [];
  for (const relativePath of filePaths) {
    files.push(
      await compareFile(
        leftRoot,
        rightRoot,
        left.files.includes(relativePath),
        right.files.includes(relativePath),
        relativePath,
        strict,
      ),
    );
  }

  return {
    key: descriptor.key,
    type: descriptor.type,
    fullName: descriptor.fullName,
    status: files.every((file) => file.status === 'IDENTICAL') ? 'IDENTICAL' : 'MODIFIED',
    files,
  };
}

async function describeOneSidedFiles(
  root: string,
  filePaths: string[],
  status: 'ADDED' | 'REMOVED',
): Promise<FileDifference[]> {
  return await Promise.all(
    filePaths.map(async (relativePath) => {
      const content = await readFile(path.join(root, relativePath));
      const side = {
        Sha256: sha256(content),
        Size: content.byteLength,
      };
      return {
        path: relativePath,
        status,
        kind: detectFileKind(relativePath, content),
        ...(status === 'ADDED'
          ? { rightSha256: side.Sha256, rightSize: side.Size }
          : { leftSha256: side.Sha256, leftSize: side.Size }),
      };
    }),
  );
}

async function compareFile(
  leftRoot: string,
  rightRoot: string,
  hasLeft: boolean,
  hasRight: boolean,
  relativePath: string,
  strict: boolean,
): Promise<FileDifference> {
  if (!hasLeft) {
    return (await describeOneSidedFiles(rightRoot, [relativePath], 'ADDED'))[0]!;
  }
  if (!hasRight) {
    return (await describeOneSidedFiles(leftRoot, [relativePath], 'REMOVED'))[0]!;
  }

  const [leftContent, rightContent] = await Promise.all([
    readFile(path.join(leftRoot, relativePath)),
    readFile(path.join(rightRoot, relativePath)),
  ]);
  const kind = detectFileKind(relativePath, leftContent, rightContent);
  const common = {
    path: relativePath,
    kind,
    leftSha256: sha256(leftContent),
    rightSha256: sha256(rightContent),
    leftSize: leftContent.byteLength,
    rightSize: rightContent.byteLength,
  };

  if (kind === 'binary') {
    return {
      ...common,
      status: leftContent.equals(rightContent) ? 'IDENTICAL' : 'MODIFIED',
    };
  }

  const leftText = normalizeText(leftContent.toString('utf8'));
  const rightText = normalizeText(rightContent.toString('utf8'));

  if (kind === 'xml') {
    const xmlChanges = compareXml(leftText, rightText);
    const strictTextChanged = strict && leftText !== rightText;
    if (xmlChanges.length === 0 && !strictTextChanged) {
      return { ...common, status: 'IDENTICAL', xmlChanges: [] };
    }
    return {
      ...common,
      status: 'MODIFIED',
      xmlChanges,
      ...(strictTextChanged
        ? {
            unifiedDiff: createTwoFilesPatch(
              `left/${relativePath}`,
              `right/${relativePath}`,
              leftText,
              rightText,
              '',
              '',
              { context: 3 },
            ),
          }
        : {}),
    };
  }

  if (leftText === rightText) {
    return { ...common, status: 'IDENTICAL' };
  }

  return {
    ...common,
    status: 'MODIFIED',
    unifiedDiff: createTwoFilesPatch(
      `left/${relativePath}`,
      `right/${relativePath}`,
      leftText,
      rightText,
      '',
      '',
      { context: 3 },
    ),
  };
}

function detectFileKind(relativePath: string, ...contents: Buffer[]): FileKind {
  const lowerPath = relativePath.toLowerCase();
  const knownTextExtensions = [
    '.cls',
    '.trigger',
    '.js',
    '.ts',
    '.html',
    '.css',
    '.cmp',
    '.app',
    '.auradoc',
    '.design',
    '.svg',
  ];

  if (
    lowerPath.endsWith('.xml') ||
    contents.every((content) => normalizeText(content.toString('utf8')).trimStart().startsWith('<?xml'))
  ) {
    return 'xml';
  }

  if (knownTextExtensions.some((extension) => lowerPath.endsWith(extension))) {
    return 'text';
  }

  return contents.every((content) => isUtf8(content) && !content.includes(0)) ? 'text' : 'binary';
}

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function summarize(components: ComponentDifference[]): ComparisonSummary {
  const count = (status: DifferenceStatus): number =>
    components.filter((component) => component.status === status).length;
  const added = count('ADDED');
  const removed = count('REMOVED');
  const modified = count('MODIFIED');
  const identical = count('IDENTICAL');
  return {
    added,
    removed,
    modified,
    identical,
    total: components.length,
    different: added + removed + modified,
  };
}

function snapshotReference(snapshot: MetadataSnapshot): SnapshotReference {
  return {
    displayName: snapshot.source.displayName,
    kind: snapshot.source.kind,
    manifestSha256: snapshot.manifestSha256,
    payloadSha256: snapshot.payloadSha256,
  };
}
