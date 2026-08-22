import pc from 'picocolors';

import type {
  ComparisonResult,
  ComponentDifference,
  DifferenceStatus,
  FileDifference,
} from '../metadata/comparator.js';

export interface TerminalReportOptions {
  detail?: boolean;
  onlyChanged?: boolean;
  color?: boolean;
}

export function renderTerminalReport(
  result: ComparisonResult,
  options: TerminalReportOptions = {},
): string {
  const color = options.color ?? process.stdout.isTTY;
  const paint = createPainter(color);
  const lines = [
    paint.heading('Salesforce 메타데이터 비교 결과'),
    `LEFT  ${result.left.displayName}`,
    `RIGHT ${result.right.displayName}`,
    '',
    [
      `전체 ${result.summary.total}`,
      paint.added(`추가 ${result.summary.added}`),
      paint.removed(`삭제 ${result.summary.removed}`),
      paint.modified(`변경 ${result.summary.modified}`),
      paint.identical(`동일 ${result.summary.identical}`),
    ].join('  '),
    '',
  ];

  const components = options.onlyChanged === false
    ? result.components
    : result.components.filter((component) => component.status !== 'IDENTICAL');

  if (components.length === 0) {
    lines.push(paint.identical('차이가 없습니다.'));
  } else {
    for (const component of components) {
      lines.push(renderComponentLine(component, paint));
      if (options.detail) {
        lines.push(...renderFileDetails(component.files, paint));
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', paint.warning('주의'));
    lines.push(...result.warnings.map((warning) => `  - ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

interface Painter {
  heading(value: string): string;
  added(value: string): string;
  removed(value: string): string;
  modified(value: string): string;
  identical(value: string): string;
  warning(value: string): string;
}

function createPainter(enabled: boolean): Painter {
  if (!enabled) {
    return {
      heading: identity,
      added: identity,
      removed: identity,
      modified: identity,
      identical: identity,
      warning: identity,
    };
  }
  return {
    heading: pc.bold,
    added: pc.green,
    removed: pc.red,
    modified: pc.yellow,
    identical: pc.dim,
    warning: pc.magenta,
  };
}

function renderComponentLine(component: ComponentDifference, paint: Painter): string {
  return `${paintStatus(component.status, component.status.padEnd(10), paint)} ${component.type.padEnd(28)} ${component.fullName}`;
}

function renderFileDetails(files: FileDifference[], paint: Painter): string[] {
  const lines: string[] = [];
  for (const file of files.filter((candidate) => candidate.status !== 'IDENTICAL')) {
    lines.push(`  ${paintStatus(file.status, file.status.padEnd(10), paint)} ${file.path}`);
    for (const change of file.xmlChanges ?? []) {
      if (change.kind === 'ADDED') {
        lines.push(paint.added(`    + ${change.path}: ${change.after ?? ''}`));
      } else if (change.kind === 'REMOVED') {
        lines.push(paint.removed(`    - ${change.path}: ${change.before ?? ''}`));
      } else {
        lines.push(paint.modified(`    ~ ${change.path}`));
        lines.push(paint.removed(`      - ${change.before ?? ''}`));
        lines.push(paint.added(`      + ${change.after ?? ''}`));
      }
    }
    if (file.unifiedDiff) {
      lines.push(...file.unifiedDiff.trimEnd().split('\n').map((line) => `    ${line}`));
    }
    if (file.kind === 'binary' && file.status === 'MODIFIED') {
      lines.push(`    SHA-256 left=${file.leftSha256} right=${file.rightSha256}`);
    }
  }
  return lines;
}

function paintStatus(status: DifferenceStatus, value: string, paint: Painter): string {
  if (status === 'ADDED') return paint.added(value);
  if (status === 'REMOVED') return paint.removed(value);
  if (status === 'MODIFIED') return paint.modified(value);
  return paint.identical(value);
}

function identity(value: string): string {
  return value;
}
