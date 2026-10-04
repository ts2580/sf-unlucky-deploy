import { XMLParser } from 'fast-xml-parser';

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
  requiredComponentNames?: readonly string[],
): ApexCoverageSummary {
  const required = requiredComponentNames === undefined
    ? undefined
    : new Set(requiredComponentNames);
  const allEntries = findCodeCoverage(deploymentResult);
  const entries = required === undefined
    ? allEntries
    : allEntries.filter((entry) => {
      const name = stringField(entry, 'name');
      return name !== undefined && required.has(name);
    });
  if (required !== undefined) {
    const reported = new Set(entries.map((entry) => stringField(entry, 'name')).filter((name): name is string => name !== undefined));
    const missing = [...required].filter((name) => !reported.has(name));
    if (missing.length > 0) {
      throw new SfudError(
        'DEPLOY_FAILED',
        `배포 payload의 Apex 클래스 또는 트리거 커버리지를 Salesforce 응답에서 확인할 수 없습니다: ${missing.join(', ')}`,
      );
    }
  }
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

/**
 * Returns the exact Apex class and trigger members selected by a package.xml.
 * A wildcard cannot be tied to a stable inventory, so the caller must defer to
 * Salesforce's own validation instead of applying the app's narrower policy.
 */
export function payloadApexCoverageInventory(
  manifestXml: string,
  testClassNames: readonly string[] = [],
): string[] | undefined {
  const parsed = new XMLParser({ ignoreAttributes: false, trimValues: true }).parse(manifestXml) as unknown;
  if (!isRecord(parsed) || parsed.Package === undefined) {
    throw new SfudError('DEPLOY_FAILED', '배포 package.xml에서 Apex 커버리지 대상을 읽을 수 없습니다.');
  }
  if (!isRecord(parsed.Package)) return [];
  const packageTypes = asRecords(parsed.Package.types);
  const names = new Set<string>();
  const tests = new Set(testClassNames);
  for (const entry of packageTypes) {
    const type = stringField(entry, 'name');
    if (type !== 'ApexClass' && type !== 'ApexTrigger') continue;
    const members = asStrings(entry.members);
    if (members.includes('*')) return undefined;
    for (const member of members) {
      if (type !== 'ApexClass' || !tests.has(member)) names.add(member);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function findCodeCoverage(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  const coverage = value.codeCoverage;
  if (Array.isArray(coverage)) {
    return coverage.filter(isRecord);
  }
  if (isRecord(coverage)) {
    return [coverage];
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

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(isRecord);
}

function asStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function formatPercentage(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
