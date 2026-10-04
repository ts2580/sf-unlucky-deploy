import { describe, expect, it } from 'vitest';
import { deploymentErrorGuidance, sanitizedErrorDetails } from './error-guidance';

describe('배포 오류 해결 안내', () => {
  it('미확정 제출은 인증 오류보다 재확인을 우선하고 새 제출을 안내하지 않는다', () => {
    const value = deploymentErrorGuidance('GIT_REAUTH_REQUIRED', 'RECONCILE_REQUIRED');
    expect(value.settings).toBeUndefined();
    expect(value.suggestion).toContain('새 배포를 제출하지 마세요');
  });
  it.each(['GIT_REAUTH_REQUIRED', 'DX_PROJECT_NOT_FOUND', 'REF_CHANGED'])('연결·프로젝트 오류 %s를 설정으로 연결한다', (code) => {
    expect(deploymentErrorGuidance(code).settings).toBe(true);
  });
  it('Org identity 변경은 저장소 오류로 설명하지 않고 인증 관리로 연결한다', () => {
    const result = deploymentErrorGuidance('ORG_IDENTITY_CHANGED');
    expect(result.fact).toContain('Org 또는 연결의 identity가 변경');
    expect(result.fact).not.toContain('DX 프로젝트');
    expect(result.destination).toBe('/auth');
    expect(deploymentErrorGuidance('GIT_REAUTH_REQUIRED').destination).toBe('/auth');
    expect(deploymentErrorGuidance('DX_PROJECT_NOT_FOUND').destination).toBe('/settings');
  });
  it('원문 문자열만으로 의존성 누락을 확정하지 않는다', () => {
    const value = deploymentErrorGuidance('UNKNOWN');
    expect(value.fact).toBe('이 작업을 완료하지 못했습니다.');
    expect(value.settings).toBeUndefined();
  });
  it('quoted JSON 및 message 안의 escaped JSON 비밀값을 정제한다', () => {
    const text = '{"access_token":"SECRET","password":"SPACE SECRET"}';
    expect(sanitizedErrorDetails(text)).not.toContain('SECRET');
    expect(sanitizedErrorDetails(JSON.stringify({ message: text }))).not.toContain('SECRET');
  });
  it('escaped quote를 포함한 비밀값 전체와 중첩 JSON 문자열의 tail을 제거한다', () => {
    const secret = 'begin"SECRET-TAIL';
    const values = [JSON.stringify({ access_token: secret }), JSON.stringify({ message: JSON.stringify({ password: secret }) }),
      `provider message ${JSON.stringify({ password: secret })}`];
    for (const value of values) {
      const sanitized = sanitizedErrorDetails(value);
      expect(sanitized).not.toContain('SECRET-TAIL');
      expect(sanitized).not.toContain('begin');
    }
  });
  it('복사할 내용에서 인증 URL, URL credentials/query, 세션, 서버 경로를 제거한다', () => {
    const cleaned = sanitizedErrorDetails('force://user:secret@host token=abc Bearer xyz https://u:pw@host.example/path?access_token=hidden#secret /home/user/private/file C:\\Users\\owner\\key 00D000000000001!session');
    for (const value of ['user:secret', 'abc', 'xyz', 'u:pw', 'hidden', 'owner', '000000000001!session']) expect(cleaned).not.toContain(value);
    expect(cleaned).toContain('https://host.example/path');
  });
});
