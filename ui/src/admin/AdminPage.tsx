import { useEffect, useState, type FormEvent } from 'react';

import { createAdminUser, listAdminUsers, updateAdminUser, type AdminUser } from './api';
import type { ApiUser } from '../auth/api';
import { Icon } from '../components/Icon';
import { PageIntro } from '../components/PageIntro';

export function AdminPage({ currentUser }: { currentUser: ApiUser }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    listAdminUsers(controller.signal)
      .then((data) => {
        setUsers(data.users);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : '사용자 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const result = await createAdminUser({
          displayName: data.get('displayName'),
          email: data.get('email'),
          role: data.get('role'),
          password: data.get('password'),
      });
      setUsers((current) => [...current, result.user!].sort(compareAdminUsers));
      setMessage(`${result.user.displayName} 계정을 생성했습니다.`);
      form.reset();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '사용자를 생성하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const updateUser = async (userId: string, changes: { role?: ApiUser['role']; disabled?: boolean }) => {
    setSavingIds((current) => new Set(current).add(userId));
    setError('');
    setMessage('');
    try {
      const result = await updateAdminUser(userId, changes);
      setUsers((current) => current.map((user) => user.id === userId ? result.user! : user).sort(compareAdminUsers));
      setMessage(`${result.user.displayName} 사용자 설정을 변경했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '사용자 설정을 변경하지 못했습니다.');
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
    }
  };

  const activeUsers = users.filter((user) => !user.disabled).length;
  const activeAdmins = users.filter((user) => !user.disabled && user.role === 'ADMIN').length;
  return (
    <div className="page-stack">
      <PageIntro
        kicker="ADMIN ONLY"
        title="사용자와 배포 권한을 관리합니다."
      />
      <section className="admin-stats" aria-label="사용자 요약">
        <div><span>전체 사용자</span><strong>{users.length}</strong></div>
        <div><span>활성 사용자</span><strong>{activeUsers}</strong></div>
        <div><span>활성 ADMIN</span><strong>{activeAdmins}</strong></div>
      </section>
      <div className="admin-layout">
        <section className="workflow-panel admin-create-panel" aria-labelledby="admin-create-heading">
          <div className="panel-heading"><span className="card-icon icon-violet"><Icon name="plus" /></span><div><h2 id="admin-create-heading">사용자 생성</h2></div></div>
          <form className="admin-user-form" onSubmit={(event) => void createUser(event)}>
            <label><span>표시 이름</span><input name="displayName" maxLength={80} required placeholder="배포 운영자" /></label>
            <label><span>이메일</span><input name="email" type="email" autoComplete="off" required placeholder="operator@example.com" /></label>
            <label><span>역할</span><select name="role" defaultValue="VIEWER"><option value="VIEWER">VIEWER · 조회 전용</option><option value="OPERATOR">OPERATOR · 비교와 Dry-run</option><option value="DEPLOYER">DEPLOYER · 실제 배포</option><option value="ADMIN">ADMIN · 사용자 관리</option></select></label>
            <label><span>초기 비밀번호</span><input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="12자 이상" /></label>
            <p><Icon name="shield" />비밀번호 원문은 저장하지 않습니다. 생성 후 사용자에게 별도 안전 채널로 전달하세요.</p>
            <button className="button button-primary" type="submit" disabled={submitting}><Icon name={submitting ? 'refresh' : 'plus'} />{submitting ? '생성 중……' : '사용자 생성'}</button>
          </form>
        </section>
        <section className="workflow-panel admin-role-guide" aria-labelledby="role-guide-heading">
          <div className="panel-heading"><span className="card-icon icon-blue"><Icon name="shield" /></span><div><h2 id="role-guide-heading">역할 기준</h2></div></div>
          <dl><div><dt>VIEWER</dt><dd>결과와 실행 이력 조회</dd></div><div><dt>OPERATOR</dt><dd>비교, 업로드, Dry-run</dd></div><div><dt>DEPLOYER</dt><dd>OPERATOR 권한과 실제 배포</dd></div><div><dt>ADMIN</dt><dd>DEPLOYER 권한과 사용자 관리</dd></div></dl>
          <p><Icon name="key" />자기 역할·활성 상태 변경과 마지막 활성 ADMIN 제거는 차단됩니다.</p>
        </section>
      </div>
      {(error || message) && <p className={error ? 'admin-feedback admin-feedback-error' : 'admin-feedback'} role={error ? 'alert' : 'status'}>{error || message}</p>}
      <section className="admin-users-panel" aria-labelledby="admin-users-heading">
        <div className="admin-users-head"><div><h2 id="admin-users-heading">등록 사용자</h2><p>역할 변경은 다음 요청부터 반영되며, 비활성화하면 기존 세션도 종료됩니다.</p></div><span>{users.length}명</span></div>
        {loading
          ? <p className="empty-runs">사용자 목록을 불러오는 중입니다.</p>
          : users.length === 0
            ? <p className="empty-runs">등록된 사용자가 없습니다.</p>
            : <div className="admin-user-list" role="list">{users.map((user) => {
              const isCurrent = user.id === currentUser.id;
              const saving = savingIds.has(user.id);
              return <article className={`admin-user-row${user.disabled ? ' admin-user-disabled' : ''}`} key={user.id} role="listitem">
                <span className="admin-user-avatar"><Icon name="user" /></span>
                <div className="admin-user-identity"><strong>{user.displayName}{isCurrent && <i>나</i>}</strong><span>{user.email}</span><small>등록 {user.createdAt.slice(0, 10)}</small></div>
                <label><span>역할</span><select aria-label={`${user.displayName} 역할`} value={user.role} disabled={saving || isCurrent} onChange={(event) => void updateUser(user.id, { role: event.target.value as ApiUser['role'] })}><option value="VIEWER">VIEWER</option><option value="OPERATOR">OPERATOR</option><option value="DEPLOYER">DEPLOYER</option><option value="ADMIN">ADMIN</option></select></label>
                <span className={`admin-user-state ${user.disabled ? 'admin-user-state-disabled' : ''}`}><i />{user.disabled ? '비활성' : '활성'}</span>
                <button className={user.disabled ? 'admin-user-enable' : 'admin-user-disable'} type="button" disabled={saving || isCurrent} onClick={() => void updateUser(user.id, { disabled: !user.disabled })}>{saving ? '저장 중……' : user.disabled ? '활성화' : '비활성화'}</button>
              </article>;
            })}</div>}
      </section>
    </div>
  );
}

export function AdminAccessDenied() {
  return <section className="admin-access-denied" role="alert"><span><Icon name="shield" /></span><h2>ADMIN 권한이 필요합니다.</h2><p>사용자 관리 화면과 API는 ADMIN 계정만 접근할 수 있습니다.</p><a className="button button-secondary" href="/">대시보드로 돌아가기</a></section>;
}

function compareAdminUsers(left: AdminUser, right: AdminUser): number {
  return Number(left.disabled) - Number(right.disabled)
    || left.displayName.localeCompare(right.displayName)
    || left.email.localeCompare(right.email);
}
