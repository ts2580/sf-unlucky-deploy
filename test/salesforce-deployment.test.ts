import { describe, expect, it } from 'vitest';

import {
  runAsyncSalesforceDeployment,
  type SalesforceDeploymentProgress,
} from '../src/deploy/salesforce-deployment.js';
import type { SfClient, SfRunOptions } from '../src/salesforce/sf-client.js';

describe('Salesforce 비동기 배포', () => {
  it('배포를 비동기로 제출하고 완료될 때까지 1초 간격으로 상태를 확인한다', async () => {
    const client = new ProgressSfClient();
    const sleeps: number[] = [];
    const progress: SalesforceDeploymentProgress[] = [];

    const result = await runAsyncSalesforceDeployment({
      sfClient: client,
      startArgs: [
        'project', 'deploy', 'start', '--target-org', 'target', '--metadata-dir', '/payload',
        '--wait', '60',
      ],
      targetAlias: 'target',
      cwd: '/project',
      phase: 'DEPLOY',
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      onProgress: (entry) => { progress.push(entry); },
    });

    expect(client.calls[0]!.args).toEqual(expect.arrayContaining(['project', 'deploy', 'start', '--async']));
    expect(client.calls[0]!.args).not.toContain('--wait');
    expect(client.calls.slice(1).every((call) => call.args.slice(0, 3).join(' ') === 'project deploy report')).toBe(true);
    expect(sleeps).toEqual([1_000]);
    expect(progress.map((entry) => entry.status)).toEqual(['Queued', 'InProgress', 'Succeeded']);
    expect(progress.at(-1)).toMatchObject({
      deploymentId: '0Af-progress', done: true, success: true,
      numberComponentsDeployed: 4, numberComponentsTotal: 4,
      numberTestsCompleted: 2, numberTestsTotal: 2,
    });
    expect(result).toMatchObject({ result: { status: 'Succeeded' } });
  });
});

class ProgressSfClient implements SfClient {
  public readonly calls: Array<{ args: readonly string[]; options: SfRunOptions }> = [];
  private reports = 0;

  public async runJson(args: readonly string[], options: SfRunOptions): Promise<unknown> {
    this.calls.push({ args, options });
    if (args[2] === 'start') {
      return { status: 0, result: { id: '0Af-progress', status: 'Queued', done: false } };
    }
    this.reports += 1;
    if (this.reports === 1) {
      return { status: 0, result: {
        id: '0Af-progress', status: 'InProgress', done: false,
        numberComponentsDeployed: 2, numberComponentsTotal: 4,
        numberTestsCompleted: 0, numberTestsTotal: 2,
      } };
    }
    return { status: 0, result: {
      id: '0Af-progress', status: 'Succeeded', done: true, success: true,
      numberComponentsDeployed: 4, numberComponentsTotal: 4,
      numberTestsCompleted: 2, numberTestsTotal: 2,
    } };
  }
}
