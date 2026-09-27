import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  apexCoverageSummary,
  payloadApexCoverageInventory,
  requireMinimumApexCoverage,
} from '../src/deploy/test-coverage.js';

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
      minimumPercentage: 75,
    });
    expect(apexCoverageSummary(result)?.percentage).toBe(75);
  });

  it('75% 미만이거나 커버리지를 확인할 수 없으면 배포를 차단한다', () => {
    expect(() => requireMinimumApexCoverage({ result: { details: { runTestResult: {
      codeCoverage: [{ numLocations: 100, numLocationsNotCovered: 26 }],
    } } } })).toThrow(/최저.*74%.*75% 미만/u);
    expect(() => requireMinimumApexCoverage({ result: { details: { runTestResult: {
      codeCoverage: [
        { numLocations: 100, numLocationsNotCovered: 0 },
        { numLocations: 100, numLocationsNotCovered: 50 },
      ],
    } } } })).toThrow(/최저.*50%.*75% 미만/u);
    expect(() => requireMinimumApexCoverage({ result: { details: { runTestResult: {
      codeCoverage: [],
    } } } })).toThrow(/확인할 수 없어/u);
  });

  it('명시 payload Apex 항목만 추가 커버리지 정책으로 검사한다', () => {
    const result = { result: { details: { runTestResult: { codeCoverage: [
      { name: 'PayloadClass', numLocations: 100, numLocationsNotCovered: 0 },
      { name: 'UnrelatedDependency', numLocations: 100, numLocationsNotCovered: 100 },
    ] } } } };
    expect(requireMinimumApexCoverage(result, 75, ['PayloadClass'])).toMatchObject({ minimumPercentage: 100 });
    expect(() => requireMinimumApexCoverage(result, 75, ['PayloadClass', 'PayloadTrigger']))
      .toThrow(/PayloadTrigger/u);
  });

  it('CLI JSON envelope의 단일 codeCoverage 객체도 payload 대상만 판정한다', () => {
    const result = {
      status: 0,
      result: {
        id: '0Af000000000001',
        details: {
          runTestResult: {
            codeCoverage: {
              id: '01p000000000001',
              name: 'PayloadClass',
              numLocations: 12,
              numLocationsNotCovered: 3,
            },
          },
        },
      },
    };

    expect(requireMinimumApexCoverage(result, 75, ['PayloadClass'])).toEqual({
      coveredLocations: 9,
      totalLocations: 12,
      percentage: 75,
      minimumPercentage: 75,
    });
  });

  it('승인된 stdOrg check-only의 마스킹 coverage fixture를 payload inventory로 판정한다', async () => {
    const result = JSON.parse(await readFile(
      new URL('./fixtures/salesforce/stdorg-quick-deploy-coverage.json', import.meta.url),
      'utf8',
    )) as unknown;

    expect(requireMinimumApexCoverage(result, 75, ['SfudQuickDeployVerificationFixture'])).toEqual({
      coveredLocations: 2,
      totalLocations: 2,
      percentage: 100,
      minimumPercentage: 100,
    });
    expect(() => requireMinimumApexCoverage(result, 75, [
      'SfudQuickDeployVerificationFixture',
      'SfudQuickDeployVerificationFixtureTest',
    ])).toThrow(/SfudQuickDeployVerificationFixtureTest/u);
  });

  it('manifest의 Apex class/trigger만 수집하고 명시 테스트 클래스와 wildcard를 구분한다', () => {
    const manifest = `<?xml version="1.0"?><Package>
      <types><members>PayloadClass</members><members>PayloadTest</members><name>ApexClass</name></types>
      <types><members>PayloadTrigger</members><name>ApexTrigger</name></types>
      <types><members>Other</members><name>CustomObject</name></types>
    </Package>`;
    expect(payloadApexCoverageInventory(manifest, ['PayloadTest']))
      .toEqual(['PayloadClass', 'PayloadTrigger']);
    expect(payloadApexCoverageInventory('<Package><types><members>*</members><name>ApexClass</name></types></Package>'))
      .toBeUndefined();
    expect(payloadApexCoverageInventory('<Package/>')).toEqual([]);
  });
});
