import { describe, expect, it, vi } from 'vitest';

import { SfudError } from '../src/core/errors.js';
import { runAsyncSalesforceDeployment } from '../src/deploy/salesforce-deployment.js';
import { ProcessSfClient, type SfClient } from '../src/salesforce/sf-client.js';

const options = {
  startArgs: ['project', 'deploy', 'start', '--target-org', 'fixture'],
  targetAlias: 'fixture', cwd: process.cwd(), phase: 'DEPLOY' as const,
  sleep: async () => undefined,
};

describe('외부 제출 경계 (R02 독립 회귀)', () => {
  it.each([
    ['제출 중 취소', new SfudError('SF_COMMAND_ABORTED', 'cancelled')],
    ['깨진 JSON', new SfudError('SF_RESPONSE_INVALID', 'invalid JSON')],
    ['출력 한도 초과', new SfudError('SF_OUTPUT_TOO_LARGE', 'output limit')],
    ['CLI 실패', new SfudError('SF_COMMAND_FAILED', 'unclassified CLI failure')],
    ['예상하지 못한 종료', new Error('child lost')],
  ])('%s 이후 수락 여부를 추정하거나 재제출하지 않는다', async (_label, error) => {
    const runJson = vi.fn<SfClient['runJson']>().mockRejectedValue(error);
    await expect(runAsyncSalesforceDeployment({ ...options, sfClient: { runJson } }))
      .rejects.toMatchObject({ code: 'SF_EXTERNAL_STATE_UNKNOWN', cause: error });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { status: 0, result: {} }, null])('ID 없는 응답 %j는 재확인이 필요하다', async (response) => {
    const runJson = vi.fn<SfClient['runJson']>().mockResolvedValue(response);
    await expect(runAsyncSalesforceDeployment({ ...options, sfClient: { runJson } }))
      .rejects.toMatchObject({ code: 'SF_EXTERNAL_STATE_UNKNOWN' });
    expect(runJson).toHaveBeenCalledTimes(1);
  });

  it('시작 전에 취소하면 제출 의도와 외부 명령을 실행하지 않는다', async () => {
    const runJson = vi.fn<SfClient['runJson']>();
    const beforeSubmit = vi.fn();
    await expect(runAsyncSalesforceDeployment({
      ...options, sfClient: { runJson }, beforeSubmit, signal: AbortSignal.abort(),
    })).rejects.toMatchObject({ code: 'SF_COMMAND_ABORTED' });
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(runJson).not.toHaveBeenCalled();
  });

  it('제출 의도 저장 실패는 원격 제출 없이 그대로 반환한다', async () => {
    const runJson = vi.fn<SfClient['runJson']>();
    const error = new Error('database connection closed');
    await expect(runAsyncSalesforceDeployment({
      ...options, sfClient: { runJson }, beforeSubmit: () => { throw error; },
    })).rejects.toBe(error);
    expect(runJson).not.toHaveBeenCalled();
  });

  it('제출 전 검사 중 취소해도 외부 명령을 실행하지 않는다', async () => {
    const controller = new AbortController();
    const runJson = vi.fn<SfClient['runJson']>();
    await expect(runAsyncSalesforceDeployment({
      ...options, sfClient: { runJson }, signal: controller.signal,
      beforeSubmit: () => { controller.abort(); },
    })).rejects.toMatchObject({ code: 'SF_COMMAND_ABORTED' });
    expect(runJson).not.toHaveBeenCalled();
  });

  it('실행 파일 부재는 프로세스 미시작 근거로 일반 실패 처리한다', async () => {
    await expect(runAsyncSalesforceDeployment({
      ...options, sfClient: new ProcessSfClient('./missing-sfud-fixture-executable'),
    })).rejects.toMatchObject({ code: 'SF_COMMAND_FAILED' });
  });

  it('ID 저장 실패 후에도 같은 ID를 조회하며 실제 제출은 한 번이다', async () => {
    const runJson = vi.fn<SfClient['runJson']>()
      .mockResolvedValueOnce({ result: { id: '0Af-fixture' } })
      .mockResolvedValueOnce({ result: { id: '0Af-fixture', done: true, success: true, status: 'Succeeded' } });
    const onPersistenceError = vi.fn();
    await expect(runAsyncSalesforceDeployment({
      ...options, sfClient: { runJson }, onSubmitted: () => { throw new Error('disk full'); }, onPersistenceError,
    })).resolves.toMatchObject({ result: { status: 'Succeeded' } });
    expect(runJson).toHaveBeenCalledTimes(2);
    expect(runJson.mock.calls[1]![0]).toContain('0Af-fixture');
    expect(onPersistenceError).toHaveBeenCalledWith('submission', expect.any(Error));
  });

  it('ID 수신 후 report 오류는 조회 실패이며 재제출하지 않는다', async () => {
    const runJson = vi.fn<SfClient['runJson']>()
      .mockResolvedValueOnce({ result: { id: '0Af-fixture' } })
      .mockRejectedValueOnce(new SfudError('SF_RESPONSE_INVALID', 'report invalid'));
    await expect(runAsyncSalesforceDeployment({ ...options, sfClient: { runJson } }))
      .rejects.toMatchObject({ code: 'SF_EXTERNAL_STATE_UNKNOWN', message: expect.stringContaining('0Af-fixture') });
    expect(runJson).toHaveBeenCalledTimes(2);
  });

  it('원격 terminal 실패 보고서는 확정 실패로 유지한다', async () => {
    const runJson = vi.fn<SfClient['runJson']>()
      .mockResolvedValueOnce({ result: { id: '0Af-fixture' } })
      .mockResolvedValueOnce({ result: { done: true, success: false, status: 'Failed' } });
    await expect(runAsyncSalesforceDeployment({ ...options, sfClient: { runJson } }))
      .rejects.toMatchObject({ code: 'DEPLOY_FAILED' });
    expect(runJson).toHaveBeenCalledTimes(2);
  });
});
