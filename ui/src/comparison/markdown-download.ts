import type { ComparisonFileDifference } from '../ComparisonFileDiff';
import type { ComparisonComponent, ComparisonJobResponse } from './api';

export interface DiffContext { sourceLabel: string; targetLabel: string; sourceSide: 'before' | 'after' }

export function renderComparisonMarkdown(job: ComparisonJobResponse, components: ComparisonComponent[], sourceSide: DiffContext['sourceSide']): string {
  const source = sourceSide === 'after' ? job.right : job.left;
  const target = sourceSide === 'after' ? job.left : job.right;
  const context = { sourceLabel: source.label, targetLabel: target.label, sourceSide };
  const lines = ['# Salesforce 메타데이터 Diff', '', ...contextLines(context),
    `- 비교 작업: ${inlineCode(job.id)}`,
    `- 비교 범위: ${inlineCode(job.manifest)}`,
    `- 비교 시각: ${inlineCode(job.completedAt ?? job.updatedAt ?? job.createdAt ?? '기록 없음')}`,
    `- 내보낸 범위: 현재 검색·상태 필터에 맞는 컴포넌트 ${components.length}개 · 모든 페이지`, '',
  ];
  for (const [label, entry] of [['SOURCE', source], ['TARGET', target]] as const) {
    if (entry.provenance !== undefined) {
      lines.push(`- ${label} Git: ${inlineCode(entry.provenance.repositoryPath)} · ${inlineCode(entry.provenance.refName)} · ${inlineCode(entry.provenance.commitSha)}`, '');
    }
  }
  if (job.result !== undefined) {
    const summary = job.result.summary;
    lines.push('## 전체 비교 요약', '', '| 전체 | 추가 | 삭제 | 변경 | 동일 |', '|---:|---:|---:|---:|---:|',
      `| ${summary.total} | ${summary.added} | ${summary.removed} | ${summary.modified} | ${summary.identical} |`, '');
    if (job.result.warnings.length > 0) lines.push('## 비교 안내', '', ...job.result.warnings.flatMap((warning) => [codeBlock(warning, 'text'), '']));
  }
  if (components.length === 0) lines.push('내보낼 항목이 없습니다.', '');
  for (const component of components) {
    lines.push(`## ${inlineCode(component.type)} · ${inlineCode(component.fullName)} · ${inlineCode(component.status)}`, '');
    for (const file of component.files) {
      lines.push(`### ${inlineCode(file.path)} · ${inlineCode(file.status)}`, '', ...fileLines(file, context));
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderFileDiffMarkdown(file: ComparisonFileDifference, context: DiffContext): string {
  return ['# Salesforce 파일 Diff', '', `- 파일: ${inlineCode(file.path)}`, `- 상태: ${inlineCode(file.status)}`,
    ...contextLines(context), '', ...fileLines(file, context), ''].join('\n');
}

function contextLines(context: DiffContext): string[] {
  return [`- SOURCE: ${inlineCode(context.sourceLabel)}`, `- TARGET: ${inlineCode(context.targetLabel)}`,
    `- 원문 diff 기호: ${context.sourceSide === 'after' ? '\`-\` TARGET · \`+\` SOURCE' : '\`-\` SOURCE · \`+\` TARGET'}`];
}

function fileLines(file: ComparisonFileDifference, context: DiffContext): string[] {
  const lines: string[] = [];
  if (file.diffTruncated) lines.push('> 비교 크기 제한으로 diff 일부가 생략되었습니다.', '');
  if (file.rawContentChanged && file.xmlSemanticStatus !== undefined) {
    lines.push(`- XML 의미 비교: ${file.xmlSemanticStatus === 'EQUAL' ? '동일' : '변경'} · ${file.xmlComparisonPolicy === 'REGISTERED' ? 'metadata type 등록 정책' : 'generic 정책'} · 원문 SHA-256은 다름`, '');
  }
  if (file.unifiedDiff) lines.push('#### 줄 단위 변경 내용', '', codeBlock(file.unifiedDiff, 'diff'), '');
  if (file.xmlChanges?.length) {
    lines.push('#### XML 경로별 변경 내용', '');
    for (const change of file.xmlChanges) {
      lines.push(`- 경로: ${inlineCode(change.path)} · ${inlineCode(change.kind ?? 'MODIFIED')}`, '',
        'SOURCE:', '', codeBlock(change[context.sourceSide] ?? '값 없음', 'text'), '',
        'TARGET:', '', codeBlock(change[context.sourceSide === 'before' ? 'after' : 'before'] ?? '값 없음', 'text'), '');
    }
  }
  if (file.kind === 'binary') {
    const sourceIsBefore = context.sourceSide === 'before';
    lines.push('#### 바이너리 파일', '',
      `- SOURCE SHA-256: ${inlineCode((sourceIsBefore ? file.leftSha256 : file.rightSha256) ?? '없음')} · ${(sourceIsBefore ? file.leftSize : file.rightSize) ?? 0} bytes`,
      `- TARGET SHA-256: ${inlineCode((sourceIsBefore ? file.rightSha256 : file.leftSha256) ?? '없음')} · ${(sourceIsBefore ? file.rightSize : file.leftSize) ?? 0} bytes`, '');
  }
  if (lines.length === 0) lines.push(file.status === 'IDENTICAL' ? '차이가 없습니다.' : '상세 diff가 제공되지 않았습니다.', '');
  return lines;
}

function codeBlock(value: string, language: string): string {
  const fence = codeFence(value, 3);
  return `${fence}${language}\n${value}\n${fence}`;
}

function inlineCode(value: string): string {
  const text = value.replace(/[\r\n]+/gu, ' ');
  const fence = codeFence(text, 1);
  return `${fence} ${text} ${fence}`;
}

function codeFence(value: string, minimum: number): string {
  let length = minimum;
  for (const match of value.matchAll(/`+/gu)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}
