import { describe, expect, it } from 'vitest';
import { renderComparisonMarkdown, renderFileDiffMarkdown } from './markdown-download';
import type { ComparisonFileDifference } from '../ComparisonFileDiff';
import type { ComparisonJobResponse } from './api';

describe('Markdown diff 다운로드 내용', () => {
  it.each(['before', 'after'] as const)('%s 방향의 Source·Target과 XML·바이너리 값을 일치시킨다', (sourceSide) => {
    const context = { sourceLabel: '업무 Source', targetLabel: '운영 Target', sourceSide };
    const file: ComparisonFileDifference = { path: 'classes/Hello.cls-meta.xml', status: 'MODIFIED', kind: 'xml',
      xmlChanges: [{ path: 'ApexClass.status', kind: 'MODIFIED', before: '이전', after: '다음' }],
      rawContentChanged: true, xmlSemanticStatus: 'DIFFERENT', xmlComparisonPolicy: 'REGISTERED', diffTruncated: true };
    const text = renderFileDiffMarkdown(file, context);
    expect(text).toContain('SOURCE: ` 업무 Source `');
    expect(text).toContain('TARGET: ` 운영 Target `');
    expect(text).toContain(sourceSide === 'after' ? '`-` TARGET · `+` SOURCE' : '`-` SOURCE · `+` TARGET');
    expect(text).toContain(`SOURCE:\n\n\x60\x60\x60text\n${sourceSide === 'after' ? '다음' : '이전'}\n\x60\x60\x60`);
    expect(text).toContain('diff 일부가 생략');
    expect(text).toContain('metadata type 등록 정책');
    const binary = renderFileDiffMarkdown({ path: 'logo.png', status: 'MODIFIED', kind: 'binary', leftSha256: 'old-sha', rightSha256: 'new-sha', leftSize: 12, rightSize: 34 }, context);
    expect(binary).toContain(sourceSide === 'after' ? 'SOURCE SHA-256: ` new-sha ` · 34 bytes' : 'SOURCE SHA-256: ` old-sha ` · 12 bytes');
    expect(binary).toContain(sourceSide === 'after' ? 'TARGET SHA-256: ` old-sha ` · 12 bytes' : 'TARGET SHA-256: ` new-sha ` · 34 bytes');
  });

  it('코드의 Markdown fence와 XML의 줄바꿈·HTML을 원문대로 보존한다', () => {
    const diff = '@@ -1 +1 @@\n-```\n+````\n+한글';
    const value = renderFileDiffMarkdown({ path: 'classes/`한글`.cls', status: 'MODIFIED', unifiedDiff: diff,
      xmlChanges: [{ path: 'markup', before: '<b>a|b</b>\n```', after: '' }] }, { sourceLabel: 'Source', targetLabel: 'Target', sourceSide: 'before' });
    expect(value).toContain('`` classes/`한글`.cls ``');
    expect(value).toContain(`\x60\x60\x60\x60\x60diff\n${diff}\n\x60\x60\x60\x60\x60`);
    expect(value).toContain('<b>a|b</b>\n```');
    expect(value).toContain('TARGET:\n\n```text\n\n```');
  });

  it('현재 필터의 항목과 전체 비교 요약·주의를 구분하고 semantic 동일 XML도 보존한다', () => {
    const component = { key: 'Profile:Admin', type: 'Profile', fullName: 'Admin', status: 'IDENTICAL' as const,
      files: [{ path: 'profiles/Admin.profile-meta.xml', status: 'IDENTICAL', kind: 'xml' as const, rawContentChanged: true, xmlSemanticStatus: 'EQUAL' as const, xmlComparisonPolicy: 'REGISTERED' as const }] };
    const job: ComparisonJobResponse = { id: 'comparison-one', status: 'SUCCEEDED', manifest: '전체',
      left: { id: 'org:target', kind: 'org', label: 'Target' }, right: { id: 'org:source', kind: 'org', label: 'Source' },
      completedAt: '2026-10-11T01:00:00Z', result: { components: [component], warnings: ['일부 diff가 생략됨'],
        summary: { total: 24, added: 2, removed: 1, modified: 20, identical: 1, different: 23 } } };
    const text = renderComparisonMarkdown(job, [component], 'after');
    expect(text).toContain('SOURCE: ` Source `');
    expect(text).toContain('TARGET: ` Target `');
    expect(text).toContain('컴포넌트 1개 · 모든 페이지');
    expect(text).toContain('| 24 | 2 | 1 | 20 | 1 |');
    expect(text).toContain('XML 의미 비교: 동일');
    expect(text).toContain('일부 diff가 생략됨');
    expect(text).toContain('2026-10-11T01:00:00Z');
  });
});
