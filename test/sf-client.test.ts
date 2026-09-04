import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractSfFailureMessage,
  isAmbiguousSalesforceFailure,
  ProcessSfClient,
  redactSensitiveText,
  sanitizeSfOutput,
} from '../src/salesforce/sf-client.js';
import { SfudError } from '../src/core/errors.js';

describe('Salesforce CLI output sanitization', () => {
  it('중첩된 인증 필드와 auth URL을 제거한다', () => {
    expect(
      sanitizeSfOutput({
        status: 0,
        result: {
          accessToken: 'secret-token',
          nested: { refreshToken: 'refresh-secret' },
          sfdxAuthUrl: 'force://client:secret@example.com',
          id: '0Af-safe',
        },
      }),
    ).toEqual({
      status: 0,
      result: {
        accessToken: '[REDACTED]',
        nested: { refreshToken: '[REDACTED]' },
        sfdxAuthUrl: '[REDACTED]',
        id: '0Af-safe',
      },
    });
  });

  it('문자열 안의 SFDX auth URL을 제거한다', () => {
    expect(redactSensitiveText('failed: force://client:secret@example.com')).toBe(
      'failed: force://[REDACTED]',
    );
  });

  it('Metadata API component failure의 실제 원인을 추출한다', () => {
    const stdout = JSON.stringify({
      status: 1,
      result: {
        status: 'Failed',
        details: {
          componentFailures: [{ problem: 'No package.xml found', problemType: 'Error' }],
        },
      },
    });

    expect(extractSfFailureMessage(stdout, '')).toBe('Failed | No package.xml found');
  });

  it('제한 시간과 전송 단절을 외부 상태가 불명확한 오류로 분류한다', () => {
    expect(isAmbiguousSalesforceFailure(
      new SfudError('SF_COMMAND_TIMEOUT', 'Salesforce CLI 명령이 제한 시간을 초과했습니다.'),
    )).toBe(true);
    expect(isAmbiguousSalesforceFailure(new Error('request aborted: ECONNRESET'))).toBe(true);
    expect(isAmbiguousSalesforceFailure(
      new SfudError('SF_COMMAND_FAILED', 'Apex 테스트가 실패했습니다.'),
    )).toBe(false);
  });
});

describe('Salesforce CLI process limits', () => {
  it('완전한 JSON 출력이 제한을 넘으면 정해진 오류로 종료한다', async () => {
    const fixture = await createNodeScript(
      `process.stdout.write(JSON.stringify({ status: 0, result: { data: 'x'.repeat(4096) } }));`,
    );
    try {
      const client = new ProcessSfClient(process.execPath);
      await expect(client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 1_000,
        maxOutputBytes: 128,
      })).rejects.toMatchObject({ code: 'SF_OUTPUT_TOO_LARGE' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('SIGTERM을 무시하는 child를 grace period 뒤 강제 종료한다', async () => {
    const fixture = await createNodeScript(
      `process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);`,
    );
    try {
      const client = new ProcessSfClient(process.execPath);
      const startedAt = Date.now();
      await expect(client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 30,
        terminationGraceMs: 30,
      })).rejects.toMatchObject({ code: 'SF_COMMAND_TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('AbortSignal이 전달되면 실행 중인 child를 종료한다', async () => {
    const fixture = await createNodeScript(`setInterval(() => undefined, 1_000);`);
    try {
      const controller = new AbortController();
      const client = new ProcessSfClient(process.execPath);
      const result = client.runJson([fixture.script], {
        cwd: fixture.root,
        timeoutMs: 1_000,
        terminationGraceMs: 30,
        signal: controller.signal,
      });
      controller.abort();
      await expect(result).rejects.toMatchObject({ code: 'SF_COMMAND_ABORTED' });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createNodeScript(contents: string): Promise<{ root: string; script: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sfud-process-'));
  const script = path.join(root, 'fixture.mjs');
  await writeFile(script, contents, { encoding: 'utf8', mode: 0o600 });
  return { root, script };
}
