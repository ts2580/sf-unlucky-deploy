import { setTimeout as delay } from 'node:timers/promises';

import { SfudError } from '../core/errors.js';
import {
  isAmbiguousSalesforceFailure,
  sanitizeSfOutput,
  type SfClient,
} from '../salesforce/sf-client.js';

export type SalesforceDeploymentPhase = 'DRY_RUN' | 'DEPLOY';

export interface SalesforceComponentFailure {
  componentType?: string;
  fullName?: string;
  fileName?: string;
  problemType?: string;
  problem: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface SalesforceTestFailure {
  name?: string;
  methodName?: string;
  message: string;
  stackTrace?: string;
  time?: number;
}

export interface SalesforceDeploymentWarning {
  name?: string;
  message: string;
}

export interface SalesforceDeploymentDiagnostics {
  componentFailures: SalesforceComponentFailure[];
  testFailures: SalesforceTestFailure[];
  codeCoverageWarnings: SalesforceDeploymentWarning[];
  flowCoverageWarnings: SalesforceDeploymentWarning[];
  messages: string[];
}

export interface SalesforceDeploymentProgress {
  phase: SalesforceDeploymentPhase;
  deploymentId: string;
  status: string;
  done: boolean;
  success?: boolean;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  numberComponentErrors?: number;
  numberTestsCompleted?: number;
  numberTestsTotal?: number;
  numberTestErrors?: number;
  diagnostics?: SalesforceDeploymentDiagnostics;
  checkedAt: string;
}

export interface AsyncSalesforceDeploymentOptions {
  sfClient: SfClient;
  startArgs: readonly string[];
  targetAlias: string;
  cwd: string;
  waitMinutes?: number;
  phase: SalesforceDeploymentPhase;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: SalesforceDeploymentProgress) => Promise<void> | void;
}

export async function runAsyncSalesforceDeployment(
  options: AsyncSalesforceDeploymentOptions,
): Promise<unknown> {
  const waitMinutes = options.waitMinutes ?? 60;
  const timeoutMs = waitMinutes * 60 * 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (async (milliseconds) => { await delay(milliseconds); });
  const startedAt = now().getTime();
  let deploymentId: string | undefined;

  try {
    const submitted = sanitizeSfOutput(await options.sfClient.runJson(
      [...withoutWait(options.startArgs), '--async'],
      { cwd: options.cwd, timeoutMs: Math.min(timeoutMs, 5 * 60 * 1_000) },
    ));
    deploymentId = extractDeploymentId(submitted);
    if (deploymentId === undefined) {
      throw new SfudError('SF_RESPONSE_INVALID', 'Salesforce 비동기 배포 ID를 확인할 수 없습니다.');
    }
    await options.onProgress?.(toProgress(submitted, options.phase, deploymentId, now));

    while (true) {
      const report = sanitizeSfOutput(await options.sfClient.runJson([
        'project', 'deploy', 'report',
        '--job-id', deploymentId,
        '--target-org', options.targetAlias,
      ], {
        cwd: options.cwd,
        timeoutMs: Math.min(timeoutMs, 5 * 60 * 1_000),
      }));
      const progress = toProgress(report, options.phase, deploymentId, now);
      await options.onProgress?.(progress);
      if (progress.done) {
        if (progress.success === false || !['Succeeded', 'SucceededPartial'].includes(progress.status)) {
          const summary = firstDiagnosticSummary(progress.diagnostics);
          throw new SfudError(
            'DEPLOY_FAILED',
            `Salesforce 배포 ${deploymentId}가 ${progress.status} 상태로 종료되었습니다.${summary === undefined ? '' : ` ${summary}`}`,
          );
        }
        return report;
      }
      if (now().getTime() - startedAt >= timeoutMs) {
        throw new SfudError(
          'SF_COMMAND_TIMEOUT',
          `Salesforce 배포 ${deploymentId} 상태 확인이 ${waitMinutes}분을 초과했습니다.`,
        );
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    if (isAmbiguousSalesforceFailure(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SfudError(
        'SF_EXTERNAL_STATE_UNKNOWN',
        `Salesforce 배포 요청의 최종 상태를 확인할 수 없습니다${deploymentId === undefined ? '' : ` (${deploymentId})`}: ${message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function withoutWait(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--wait') {
      index += 1;
      continue;
    }
    if (args[index] !== '--async') result.push(args[index]!);
  }
  return result;
}

function toProgress(
  value: unknown,
  phase: SalesforceDeploymentPhase,
  deploymentId: string,
  now: () => Date,
): SalesforceDeploymentProgress {
  const result = deploymentResult(value);
  const status = stringValue(result.status) ?? 'Queued';
  const done = booleanValue(result.done) ?? isTerminalStatus(status);
  const diagnostics = deploymentDiagnostics(value);
  return {
    phase,
    deploymentId,
    status,
    done,
    ...optionalBoolean('success', result.success),
    ...optionalNumber('numberComponentsDeployed', result.numberComponentsDeployed),
    ...optionalNumber('numberComponentsTotal', result.numberComponentsTotal),
    ...optionalNumber('numberComponentErrors', result.numberComponentErrors),
    ...optionalNumber('numberTestsCompleted', result.numberTestsCompleted),
    ...optionalNumber('numberTestsTotal', result.numberTestsTotal),
    ...optionalNumber('numberTestErrors', result.numberTestErrors),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    checkedAt: now().toISOString(),
  };
}

function deploymentDiagnostics(value: unknown): SalesforceDeploymentDiagnostics | undefined {
  const result = deploymentResult(value);
  const details = isRecord(result.details) ? result.details : {};
  const runTestResult = isRecord(details.runTestResult) ? details.runTestResult : {};
  const componentFailures = asArray(details.componentFailures).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const problem = stringValue(entry.problem) ?? stringValue(entry.message);
    if (problem === undefined) return [];
    return [{
      ...optionalString('componentType', entry.componentType),
      ...optionalString('fullName', entry.fullName),
      ...optionalString('fileName', entry.fileName),
      ...optionalString('problemType', entry.problemType),
      problem,
      ...optionalNumber('lineNumber', entry.lineNumber),
      ...optionalNumber('columnNumber', entry.columnNumber),
    }];
  });
  const testFailures = asArray(runTestResult.failures).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const message = stringValue(entry.message) ?? stringValue(entry.problem);
    if (message === undefined) return [];
    return [{
      ...optionalString('name', entry.name),
      ...optionalString('methodName', entry.methodName),
      message,
      ...optionalString('stackTrace', entry.stackTrace),
      ...optionalNumber('time', entry.time),
    }];
  });
  const codeCoverageWarnings = parseWarnings(runTestResult.codeCoverageWarnings);
  const flowCoverageWarnings = parseWarnings(runTestResult.flowCoverageWarnings);
  const messages = uniqueStrings([
    ...parseMessages(result.messages),
    ...parseMessages(result.errors),
    ...parseMessages(result.errorMessage),
    ...parseMessages(result.problem),
  ]);
  if (
    componentFailures.length === 0
    && testFailures.length === 0
    && codeCoverageWarnings.length === 0
    && flowCoverageWarnings.length === 0
    && messages.length === 0
  ) return undefined;
  return { componentFailures, testFailures, codeCoverageWarnings, flowCoverageWarnings, messages };
}

function parseWarnings(value: unknown): SalesforceDeploymentWarning[] {
  return asArray(value).flatMap((entry) => {
    if (typeof entry === 'string' && entry.length > 0) return [{ message: entry }];
    if (!isRecord(entry)) return [];
    const message = stringValue(entry.message) ?? stringValue(entry.problem);
    if (message === undefined) return [];
    return [{ ...optionalString('name', entry.name), message }];
  });
}

function parseMessages(value: unknown): string[] {
  return asArray(value).flatMap((entry) => {
    if (typeof entry === 'string' && entry.length > 0) return [entry];
    if (!isRecord(entry)) return [];
    return [entry.message, entry.problem, entry.errorMessage]
      .flatMap((candidate) => stringValue(candidate) ?? []);
  });
}

function firstDiagnosticSummary(diagnostics: SalesforceDeploymentDiagnostics | undefined): string | undefined {
  const component = diagnostics?.componentFailures[0];
  if (component !== undefined) {
    const name = [component.componentType, component.fullName].filter(Boolean).join(' ');
    const location = component.fileName === undefined
      ? ''
      : ` (${component.fileName}${component.lineNumber === undefined ? '' : `:${component.lineNumber}`})`;
    return `${name.length === 0 ? '컴포넌트 오류' : name}${location}: ${component.problem}`;
  }
  const test = diagnostics?.testFailures[0];
  if (test !== undefined) {
    const name = [test.name, test.methodName].filter(Boolean).join('.');
    return `${name.length === 0 ? 'Apex 테스트 오류' : name}: ${test.message}`;
  }
  const coverage = diagnostics?.codeCoverageWarnings[0] ?? diagnostics?.flowCoverageWarnings[0];
  if (coverage !== undefined) return `${coverage.name === undefined ? '' : `${coverage.name}: `}${coverage.message}`;
  return diagnostics?.messages[0];
}

function deploymentResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return isRecord(value.result) ? value.result : value;
}

function extractDeploymentId(value: unknown): string | undefined {
  const result = deploymentResult(value);
  for (const key of ['id', 'deployId', 'deploymentId']) {
    const candidate = stringValue(result[key]);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function isTerminalStatus(status: string): boolean {
  return ['Succeeded', 'Failed', 'Canceled', 'SucceededPartial'].includes(status);
}

function optionalNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } as Record<Key, number> : {};
}

function optionalBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  return typeof value === 'boolean' ? { [key]: value } as Record<Key, boolean> : {};
}

function optionalString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  const parsed = stringValue(value);
  return parsed === undefined ? {} : { [key]: parsed } as Record<Key, string>;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
