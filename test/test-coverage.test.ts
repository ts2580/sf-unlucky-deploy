import { describe, expect, it } from 'vitest';

import { apexCoverageSummary, requireMinimumApexCoverage } from '../src/deploy/test-coverage.js';

describe('Apex 테스트 커버리지', () => {
  it('Salesforce 배포 응답의 전체 라인 커버리지를 합산한다', () => {
    const result = { result: { details: { runTestResult: { codeCoverage: [
      { name: 'AccountService', numLocations: 80, numLocationsNotCovered: 20 },
      { name: 'OrderService', numLocations: 20, numLocationsNotCovered: 5 },
    ] } } } };

    expect(requireMinimumApexCoverage(result)).toEqual({
      coveredLocations: 75,
      totalLocations: 100,
      percentage: 75,
    });
    expect(apexCoverageSummary(result)?.percentage).toBe(75);
  });

  it('75% 미만이거나 커버리지를 확인할 수 없으면 배포를 차단한다', () => {
    expect(() => requireMinimumApexCoverage({ result: { details: { runTestResult: {
      codeCoverage: [{ numLocations: 100, numLocationsNotCovered: 26 }],
    } } } })).toThrow(/74%.*75% 미만/u);
    expect(() => requireMinimumApexCoverage({ result: { details: { runTestResult: {
      codeCoverage: [],
    } } } })).toThrow(/확인할 수 없어/u);
  });
});
