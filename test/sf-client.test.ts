import { describe, expect, it } from 'vitest';

import {
  extractSfFailureMessage,
  isAmbiguousSalesforceFailure,
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
