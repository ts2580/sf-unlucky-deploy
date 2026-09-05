import { expect, test } from '@playwright/test';

import type { ComparisonResult } from '../src/metadata/comparator.js';
import { renderHtmlReport } from '../src/reports/html.js';

test('변경 요약과 XML 이전·새 값을 렌더링한다', async ({ page }) => {
  await page.setContent(renderHtmlReport(comparisonFixture()));

  await expect(page.getByTestId('report-title')).toHaveText('Salesforce 메타데이터 비교 결과');
  await expect(page.getByTestId('left-source')).toHaveText('local:/workspace/source');
  await expect(page.getByTestId('right-source')).toHaveText('org:target');
  await expect(page.locator('[data-summary="변경"]')).toHaveText('1');
  await expect(page.getByTestId('component')).toHaveCount(1);
  await expect(page.getByText('CustomObject', { exact: true })).toBeVisible();
  await expect(page.getByText('주문 상태', { exact: true })).toBeVisible();
  await expect(page.getByText('처리 상태', { exact: true })).toBeVisible();
});

test('모바일 화면에서 수평으로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(renderHtmlReport(comparisonFixture()));

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  await expect(page.getByTestId('summary')).toBeVisible();
});

test('원문 hash가 다른 semantic 동일 XML을 별도로 표시한다', async ({ page }) => {
  const fixture = comparisonFixture();
  fixture.summary = { added: 0, removed: 0, modified: 1, identical: 1, total: 2, different: 1 };
  fixture.components.push({
    key: 'Profile:Admin',
    type: 'Profile',
    fullName: 'Admin',
    status: 'IDENTICAL',
    files: [{
      path: 'profiles/Admin.profile',
      status: 'IDENTICAL',
      kind: 'xml',
      leftSha256: 'left-profile',
      rightSha256: 'right-profile',
      rawContentChanged: true,
      xmlSemanticStatus: 'EQUAL',
      xmlComparisonPolicy: 'REGISTERED',
      xmlChanges: [],
    }],
  });

  await page.setContent(renderHtmlReport(fixture));

  await expect(page.getByTestId('semantic-equal')).toContainText('Profile');
  await expect(page.getByTestId('semantic-equal')).toContainText('metadata type 등록 정책');
});

function comparisonFixture(): ComparisonResult {
  return {
    generatedAt: '2026-08-22T00:00:00.000Z',
    strict: false,
    left: {
      displayName: 'local:/workspace/source',
      kind: 'local',
      manifestSha256: 'manifest',
      payloadSha256: 'left',
    },
    right: {
      displayName: 'org:target',
      kind: 'org',
      manifestSha256: 'manifest',
      payloadSha256: 'right',
    },
    summary: { added: 0, removed: 0, modified: 1, identical: 0, total: 1, different: 1 },
    warnings: [],
    components: [
      {
        key: 'CustomObject:Order__c',
        type: 'CustomObject',
        fullName: 'Order__c',
        status: 'MODIFIED',
        files: [
          {
            path: 'objects/Order__c.object',
            status: 'MODIFIED',
            kind: 'xml',
            xmlChanges: [
              {
                kind: 'MODIFIED',
                path: 'CustomObject.fields[fullName=Status__c].label',
                before: '주문 상태',
                after: '처리 상태',
              },
            ],
          },
        ],
      },
    ],
  };
}
