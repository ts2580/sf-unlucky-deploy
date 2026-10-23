import { describe, expect, it } from 'vitest';
import { renderComparisonDownload, renderFileDiffDownload } from './diff-download';
import type { ComparisonJobResponse } from './api';
import type { ComparisonFileDifference } from './ComparisonFileDiff';

const file: ComparisonFileDifference = {
  path: 'classes/한글.cls', status: 'MODIFIED', kind: 'xml', unifiedDiff: '@@ -1 +1 @@\n-"이전", 값\n+새 값',
  xmlChanges: [{ path: 'status', before: '', after: 'Active' }],
  leftSha256: 'old', rightSha256: 'new', leftSize: 0, rightSize: 12, diffTruncated: true,
  rawContentChanged: true, xmlSemanticStatus: 'DIFFERENT', xmlComparisonPolicy: 'REGISTERED',
};

describe('diff 형식별 내보내기', () => {
  it.each(['before', 'after'] as const)('%s 방향과 상세 diff 정보를 보존한다', (sourceSide) => {
    const context = { sourceLabel: '개발', targetLabel: '운영', sourceSide };
    const exported = JSON.parse(renderFileDiffDownload(file, context, 'json'));
    expect(exported).toEqual({ ...context, file });
    const csv = renderFileDiffDownload(file, context, 'csv');
    expect(csv).toContain(sourceSide === 'before' ? '"old","new","0","12"' : '"new","old","12","0"');
    expect(csv).toContain(sourceSide === 'before' ? '""source"":"""",""target"":""Active""' : '""source"":""Active"",""target"":""""');
    expect(csv).toContain('"DIFFERENT","REGISTERED","true","true"');
  });

  it('CSV의 한글·쉼표·따옴표·여러 줄을 보존하고 수식 실행을 방지한다', () => {
    const csv = renderFileDiffDownload(file, { sourceLabel: '=SUM(1,2)', targetLabel: '운영', sourceSide: 'before' }, 'csv');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"\'@@ -1 +1 @@\n-""이전"", 값\n+새 값"');
    expect(csv).toContain('classes/한글.cls');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it.each(['csv', 'json'] as const)('%s는 전달된 필터 범위만 내보내고 전체 요약은 유지한다', (format) => {
    const selected = { key: 'ApexClass:선택', type: 'ApexClass', fullName: '선택', status: 'MODIFIED' as const, files: [file] };
    const excluded = { ...selected, key: '제외', fullName: '제외' };
    const job: ComparisonJobResponse = { id: 'job', status: 'SUCCEEDED', manifest: '전체',
      left: { id: 'target', kind: 'org', label: '운영' }, right: { id: 'source', kind: 'local', label: '개발' },
      result: { components: [selected, excluded], warnings: ['일부 생략'], summary: { total: 2, modified: 2, added: 0, removed: 0, identical: 0, different: 2 } } };
    const text = renderComparisonDownload(job, [selected], 'after', format);
    expect(text).toContain('선택');
    expect(text).not.toContain('제외');
    expect(text).toContain('일부 생략');
    if (format === 'json') {
      const value = JSON.parse(text);
      expect(value.components).toEqual([selected]);
      expect(value.componentCount).toBe(1);
      expect(value.summary.total).toBe(2);
      expect(value.source.label).toBe('개발');
    }
    const empty = renderComparisonDownload(job, [], 'after', format);
    if (format === 'json') expect(JSON.parse(empty).components).toEqual([]);
    else expect(empty.trim().split('\r\n')).toHaveLength(1);
  });
});
