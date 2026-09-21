import type { ComparisonResult, FileDifference } from '../metadata/comparator.js';

export function renderMarkdownReport(result: ComparisonResult): string {
  const lines = [
    result.comparisonLimit?.exceeded === true ? '# Salesforce Source 목록 · 비교하지 않음' : '# Salesforce 메타데이터 비교 결과',
    '',
    `- 생성 시각: ${result.generatedAt}`,
    `- LEFT: \`${escapeInlineCode(result.left.displayName)}\``,
    `- RIGHT: \`${escapeInlineCode(result.right.displayName)}\``,
    `- 비교 모드: ${result.comparisonLimit?.exceeded === true ? '파일 수 제한 초과로 비교 생략' : result.strict ? 'strict' : 'metadata-aware'}`,
    '',
    '## 요약',
    '',
    ...(result.comparisonLimit?.exceeded === true
      ? [`Source 컴포넌트 ${result.summary.total}개 · 차이 판정 없음`]
      : ['| 전체 | 추가 | 삭제 | 변경 | 동일 |', '|---:|---:|---:|---:|---:|',
        `| ${result.summary.total} | ${result.summary.added} | ${result.summary.removed} | ${result.summary.modified} | ${result.summary.identical} |`]),
    '',
  ];

  if (result.warnings.length > 0) {
    lines.push('## 주의', '', ...result.warnings.map((warning) => `- ${warning}`), '');
  }

  const semanticEqualFiles = result.components.flatMap((component) =>
    component.files.flatMap((file) =>
      file.rawContentChanged === true && file.xmlSemanticStatus === 'EQUAL'
        ? [{ component, file }]
        : []));
  if (semanticEqualFiles.length > 0) {
    lines.push('## 원문이 다른 semantic 동일 XML', '');
    for (const { component, file } of semanticEqualFiles) {
      lines.push(
        `- ${component.type} · \`${escapeInlineCode(component.fullName)}\` · \`${escapeInlineCode(file.path)}\` · ${xmlPolicyLabel(file)}`,
      );
    }
    lines.push('');
  }

  lines.push(result.comparisonLimit?.exceeded === true ? '## Source 컴포넌트' : '## 변경된 컴포넌트', '');
  const changed = result.components.filter((component) => component.status !== 'IDENTICAL');
  if (changed.length === 0) {
    lines.push(result.comparisonLimit?.exceeded === true ? 'Source 메타데이터가 없습니다.' : '차이가 없습니다.', '');
  }

  for (const component of changed) {
    lines.push(`### ${component.status} · ${component.type} · \`${escapeInlineCode(component.fullName)}\``, '');
    for (const file of component.files.filter((candidate) => candidate.status !== 'IDENTICAL')) {
      lines.push(`#### ${file.status} · \`${escapeInlineCode(file.path)}\``, '');
      lines.push(...renderFileDifference(file));
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderFileDifference(file: FileDifference): string[] {
  const lines: string[] = [];
  if (file.rawContentChanged === true && file.xmlSemanticStatus !== undefined) {
    lines.push(
      `- XML 의미 비교: ${file.xmlSemanticStatus === 'EQUAL' ? '동일' : '변경'} (${xmlPolicyLabel(file)}), 원문 SHA-256은 다름`,
      '',
    );
  }
  if (file.xmlChanges && file.xmlChanges.length > 0) {
    lines.push('| 상태 | 경로 | 이전 값 | 새 값 |', '|---|---|---|---|');
    for (const change of file.xmlChanges) {
      lines.push(
        `| ${change.kind} | \`${escapeInlineCode(change.path)}\` | ${escapeTable(change.before ?? '')} | ${escapeTable(change.after ?? '')} |`,
      );
    }
    lines.push('');
  }

  if (file.unifiedDiff) {
    lines.push('```diff', file.unifiedDiff.trimEnd(), '```', '');
  }

  if (file.kind === 'binary' && file.status !== 'SOURCE') {
    lines.push(
      `- LEFT: ${file.leftSha256 ?? '없음'} (${file.leftSize ?? 0} bytes)`,
      `- RIGHT: ${file.rightSha256 ?? '없음'} (${file.rightSize ?? 0} bytes)`,
      '',
    );
  }
  return lines;
}

function xmlPolicyLabel(file: FileDifference): string {
  return file.xmlComparisonPolicy === 'REGISTERED' ? 'metadata type 등록 정책' : 'generic 정책';
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/gu, '\\`');
}

function escapeTable(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>');
}
