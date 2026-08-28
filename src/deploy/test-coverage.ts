import { SfudError } from '../core/errors.js';

export interface ApexCoverageSummary {
  coveredLocations: number;
  totalLocations: number;
  percentage: number;
  minimumPercentage: number;
}

export function requireMinimumApexCoverage(
  deploymentResult: unknown,
  minimumPercentage = 75,
): ApexCoverageSummary {
  const entries = findCodeCoverage(deploymentResult);
  let totalLocations = 0;
  let coveredLocations = 0;
  const percentages: number[] = [];
  for (const entry of entries) {
    const locations = numericField(entry, 'numLocations');
    const uncovered = numericField(entry, 'numLocationsNotCovered');
    if (locations === undefined || uncovered === undefined || locations <= 0) continue;
    totalLocations += locations;
    const covered = Math.max(0, locations - uncovered);
    coveredLocations += covered;
    percentages.push((covered / locations) * 100);
  }
  if (totalLocations === 0) {
    throw new SfudError(
      'DEPLOY_FAILED',
      '선택한 Apex 테스트의 코드 커버리지를 Salesforce 응답에서 확인할 수 없어 실제 배포를 중단했습니다.',
    );
  }
  const percentage = (coveredLocations / totalLocations) * 100;
  const lowestPercentage = Math.min(...percentages);
  if (lowestPercentage < minimumPercentage) {
    throw new SfudError(
      'DEPLOY_FAILED',
      `선택한 Apex 테스트의 클래스별 최저 코드 커버리지가 ${formatPercentage(lowestPercentage)}%로 ${minimumPercentage}% 미만입니다.`,
    );
  }
  return { coveredLocations, totalLocations, percentage, minimumPercentage: lowestPercentage };
}

export function apexCoverageSummary(deploymentResult: unknown): ApexCoverageSummary | undefined {
  try {
    return requireMinimumApexCoverage(deploymentResult, 0);
  } catch {
    return undefined;
  }
}

function findCodeCoverage(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.codeCoverage)) {
    return value.codeCoverage.filter(isRecord);
  }
  for (const nested of Object.values(value)) {
    const found = findCodeCoverage(nested);
    if (found.length > 0) return found;
  }
  return [];
}

function numericField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
