import { useState, type FormEvent } from 'react';

import { authenticate, type ApiUser } from './api';
import { Icon } from '../components/Icon';

export function AuthLoading({ failed }: { failed: boolean }) {
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-live="polite">
        <img src="/favicon.svg" alt="" />
        <p className="eyebrow">SFUD ACCESS</p>
        <h1>{failed ? '인증 서버에 연결할 수 없습니다.' : '보안 상태를 확인하고 있습니다……'}</h1>
        {failed && <button className="button button-primary" type="button" onClick={() => window.location.reload()}>다시 시도</button>}
      </section>
    </main>
  );
}

export function AuthScreen({
  setupRequired,
  onAuthenticated,
}: {
  setupRequired: boolean;
  onAuthenticated: (user: ApiUser) => void;
}) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const body = setupRequired
      ? {
          bootstrapToken: form.get('bootstrapToken'),
          email: form.get('email'),
          displayName: form.get('displayName'),
          password: form.get('password'),
        }
      : { email: form.get('email'), password: form.get('password') };
    try {
      const result = await authenticate(setupRequired, body);
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '인증하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <div className="auth-backdrop"><i /><i /></div>
      <section className="auth-card">
        <div className="auth-brand"><img src="/favicon.svg" alt="" /><span><strong>sfud</strong><small>Deployment Console</small></span></div>
        <span className="auth-icon"><Icon name={setupRequired ? 'key' : 'shield'} /></span>
        <p className="eyebrow">{setupRequired ? 'FIRST ADMIN' : 'SECURE ACCESS'}</p>
        <h1>{setupRequired ? '최초 관리자를 설정합니다.' : '다시 오셨군요.'}</h1>
        <p>{setupRequired
          ? '서버 시작 로그에 표시된 일회용 설정 코드와 관리자 정보를 입력하세요.'
          : '배포 콘솔에 접근하려면 관리자에게 등록된 계정으로 로그인하세요.'}</p>
        <form onSubmit={(event) => void submit(event)}>
          {setupRequired && <>
            <label htmlFor="bootstrap-token">초기 설정 코드</label>
            <input id="bootstrap-token" name="bootstrapToken" autoComplete="off" required />
            <label htmlFor="display-name">표시 이름</label>
            <input id="display-name" name="displayName" autoComplete="name" maxLength={80} required />
          </>}
          <label htmlFor="auth-email">이메일</label>
          <input id="auth-email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="auth-password">비밀번호</label>
          <input id="auth-password" name="password" type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required />
          {setupRequired && <small className="auth-hint">12자 이상 128자 이하로 입력하세요.</small>}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary" type="submit" disabled={submitting}>
            <Icon name={setupRequired ? 'key' : 'shield'} />{submitting ? '확인 중……' : setupRequired ? '관리자 생성' : '로그인'}
          </button>
        </form>
        <div className="auth-security"><Icon name="shield" />세션 원문과 비밀번호는 데이터베이스에 저장하지 않습니다.</div>
      </section>
    </main>
  );
}
