import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createTwoFilesPatch } from 'diff';

import { SfudError } from '../core/errors.js';
import { sha256File } from '../core/files.js';
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
  diffTruncated?: boolean;
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

const COMPONENT_COMPARISON_CONCURRENCY = 8;
export const MAX_DIFF_INPUT_BYTES = 1024 * 1024;
const MAX_UNIFIED_DIFF_CHARACTERS = 512 * 1024;
const MAX_UNIFIED_DIFF_LINES = 5_000;
const MAX_XML_CHANGES = 2_000;

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
  const components = await mapWithConcurrency(keys, COMPONENT_COMPARISON_CONCURRENCY, async (key) => {
    const leftComponent = leftComponents.get(key);
    const rightComponent = rightComponents.get(key);
    return await compareComponent(
      left.packageRoot,
      right.packageRoot,
      leftComponent,
      rightComponent,
      options.strict ?? false,
    );
  });

  const summary = summarize(components);
  const hasPermissionMetadata = components.some(
    (component) => component.type === 'Profile' || component.type === 'PermissionSet',
  );

  const warnings = hasPermissionMetadata
    ? ['Profile과 PermissionSet 결과는 동일 manifest에 포함된 메타데이터 범위 안에서만 유효합니다.']
    : [];
  if (components.some((component) => component.files.some((file) => file.diffTruncated === true))) {
    warnings.push('크기 상한을 넘은 파일은 checksum만 비교했으며 상세 diff 일부를 생략했습니다.');
  }

  return {
    generatedAt: new Date().toISOString(),
    strict: options.strict ?? false,
    left: snapshotReference(left),
    right: snapshotReference(right),
    summary,
    components,
    warnings,
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

  const leftFilePaths = new Set(left.files);
  const rightFilePaths = new Set(right.files);
  const filePaths = [...new Set([...leftFilePaths, ...rightFilePaths])].sort((a, b) =>
    a.localeCompare(b),
  );
  const files: FileDifference[] = [];
  for (const relativePath of filePaths) {
    files.push(
      await compareFile(
        leftRoot,
        rightRoot,
        leftFilePaths.has(relativePath),
        rightFilePaths.has(relativePath),
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
      const absolutePath = path.join(root, relativePath);
      const fileStat = await stat(absolutePath);
      const side = {
        Sha256: await sha256File(absolutePath),
        Size: fileStat.size,
      };
      return {
        path: relativePath,
        status,
        kind: detectFileKind(relativePath),
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

  const [leftStat, rightStat] = await Promise.all([
    stat(path.join(leftRoot, relativePath)),
    stat(path.join(rightRoot, relativePath)),
  ]);
  if (Math.max(leftStat.size, rightStat.size) > MAX_DIFF_INPUT_BYTES) {
    const [leftSha256, rightSha256] = await Promise.all([
      sha256File(path.join(leftRoot, relativePath)),
      sha256File(path.join(rightRoot, relativePath)),
    ]);
    const kind = detectFileKind(relativePath);
    const status = leftStat.size === rightStat.size && leftSha256 === rightSha256
      ? 'IDENTICAL' as const
      : 'MODIFIED' as const;
    return {
      path: relativePath,
      kind,
      leftSha256,
      rightSha256,
      leftSize: leftStat.size,
      rightSize: rightStat.size,
      status,
      ...(status === 'MODIFIED' && kind !== 'binary' ? { diffTruncated: true } : {}),
      ...(status === 'IDENTICAL' && kind === 'xml' ? { xmlChanges: [] } : {}),
    };
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

  if (leftContent.equals(rightContent)) {
    return {
      ...common,
      status: 'IDENTICAL',
      ...(kind === 'xml' ? { xmlChanges: [] } : {}),
    };
  }

  if (kind === 'binary') {
    return {
      ...common,
      status: 'MODIFIED',
    };
  }

  const leftText = normalizeText(leftContent.toString('utf8'));
  const rightText = normalizeText(rightContent.toString('utf8'));

  if (kind === 'xml') {
    const allXmlChanges = compareXml(leftText, rightText);
    const xmlChanges = allXmlChanges.slice(0, MAX_XML_CHANGES);
    const xmlChangesTruncated = allXmlChanges.length > xmlChanges.length;
    const strictTextChanged = strict && leftText !== rightText;
    if (xmlChanges.length === 0 && !strictTextChanged) {
      return { ...common, status: 'IDENTICAL', xmlChanges: [] };
    }
    const unified: { unifiedDiff?: string; diffTruncated?: true } = strictTextChanged
      ? boundedUnifiedDiff(createTwoFilesPatch(
        `left/${relativePath}`,
        `right/${relativePath}`,
        leftText,
        rightText,
        '',
        '',
        { context: 3 },
      ))
      : {};
    return {
      ...common,
      status: 'MODIFIED',
      xmlChanges,
      ...unified,
      ...(xmlChangesTruncated || unified.diffTruncated === true ? { diffTruncated: true } : {}),
    };
  }

  if (leftText === rightText) {
    return { ...common, status: 'IDENTICAL' };
  }

  return {
    ...common,
    status: 'MODIFIED',
    ...boundedUnifiedDiff(createTwoFilesPatch(
      `left/${relativePath}`,
      `right/${relativePath}`,
      leftText,
      rightText,
      '',
      '',
      { context: 3 },
    )),
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
    (contents.length > 0
      && contents.every((content) => normalizeText(content.toString('utf8')).trimStart().startsWith('<?xml')))
  ) {
    return 'xml';
  }

  if (knownTextExtensions.some((extension) => lowerPath.endsWith(extension))) {
    return 'text';
  }

  return contents.every((content) => isUtf8(content) && !content.includes(0)) ? 'text' : 'binary';
}

function boundedUnifiedDiff(value: string): { unifiedDiff: string; diffTruncated?: true } {
  let bounded = value;
  let truncated = false;
  if (bounded.length > MAX_UNIFIED_DIFF_CHARACTERS) {
    bounded = bounded.slice(0, MAX_UNIFIED_DIFF_CHARACTERS);
    truncated = true;
  }
  const lines = bounded.split('\n');
  if (lines.length > MAX_UNIFIED_DIFF_LINES) {
    bounded = lines.slice(0, MAX_UNIFIED_DIFF_LINES).join('\n');
    truncated = true;
  }
  if (truncated) bounded = `${bounded.trimEnd()}\n... [diff truncated]\n`;
  return { unifiedDiff: bounded, ...(truncated ? { diffTruncated: true as const } : {}) };
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

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
