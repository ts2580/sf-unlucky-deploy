import { executeComparison, type ExecuteComparisonDependencies, type ExecuteComparisonOptions } from '../compare/composition.js';
import { executeDeployment, type ExecuteDeploymentDependencies, type ExecuteDeploymentOptions } from '../deploy/composition.js';
import { renderTerminalReport } from '../reports/public.js';

interface Presentation { json?: boolean; color?: boolean }
export interface CommandDependencies extends ExecuteComparisonDependencies { stdout?: (value: string) => void }
export interface DeployCommandDependencies extends ExecuteDeploymentDependencies { stdout?: (value: string) => void }

export async function runCompareCommand(options: ExecuteComparisonOptions & Presentation & { detail?: boolean; failOnDiff?: boolean }, dependencies: CommandDependencies = {}) {
  const { json, color, detail, failOnDiff, ...execution } = options;
  const { stdout = (value: string) => { process.stdout.write(value); }, ...context } = dependencies;
  const result = await executeComparison(execution, context);
  if (json) stdout(`${JSON.stringify({ comparison: result.comparison, reports: result.reports }, null, 2)}\n`);
  else {
    stdout(renderTerminalReport(result.comparison, { detail: detail ?? false,
      onlyChanged: !options.showIdentical, color: color ?? process.stdout.isTTY }));
    stdout(`리포트: ${result.reports.html}\n`);
  }
  return { ...result, exitCode: failOnDiff && result.comparison.summary.different > 0 ? 1 : 0 };
}

export async function runDeployCommand(options: ExecuteDeploymentOptions & Presentation, dependencies: DeployCommandDependencies = {}) {
  const { json, color, ...execution } = options;
  const { stdout = (value: string) => { process.stdout.write(value); }, onPrepared, ...context } = dependencies;
  const result = await executeDeployment(execution, {
    ...context,
    onPrepared(prepared) {
      onPrepared?.(prepared);
      if (json) return;
      stdout(renderTerminalReport(prepared.comparison, { detail: true, color: color ?? process.stdout.isTTY }));
      stdout(`리포트: ${prepared.reports.html}\n`);
      const plan = prepared.testPlan;
      stdout(`Apex 테스트: ${plan.level}${plan.tests.length > 0 ? ` (${plan.tests.join(', ')})` : ''} [${plan.selection}]\n`);
    },
  });
  if (json) stdout(`${JSON.stringify(result, null, 2)}\n`);
  else stdout(options.execute
    ? options.skipDryRun === true ? '실제 배포 완료\n' : 'dry-run 및 실제 배포 완료\n'
    : 'dry-run 완료 (실제 배포는 실행하지 않음)\n');
  return result;
}
