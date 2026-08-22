import { describe, expect, it } from 'vitest';

import {
  extractSfFailureMessage,
  redactSensitiveText,
  sanitizeSfOutput,
} from '../src/salesforce/sf-client.js';

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
});
