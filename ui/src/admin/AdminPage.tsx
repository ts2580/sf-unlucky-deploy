import { useEffect, useState, type FormEvent } from 'react';

import {
  createAdminUser,
  grantOrgExecutionAccess,
  listAdminUsers,
  listOrgExecutionGrants,
  revokeOrgExecutionAccess,
  updateAdminUser,
  type AdminUser,
  type OrgExecutionGrant,
  type OrgExecutionPolicy,
} from './api';
import type { ApiUser } from '../auth/api';
import { Icon } from '../components/Icon';
import { PageIntro } from '../components/PageIntro';
import { apiRequest } from '../api-client';
import { ConnectionDialog } from '../components/ConnectionDialog';

export function AdminPage({ currentUser }: { currentUser: ApiUser }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [grants, setGrants] = useState<OrgExecutionGrant[]>([]);
  const [policies, setPolicies] = useState<OrgExecutionPolicy[]>([]);
  const [legacyPolicies, setLegacyPolicies] = useState<Array<{ targetAlias: string; grantCount: number }>>([]);
  const [unownedJobs, setUnownedJobs] = useState<Array<{ resource: string; id: string; status: string; createdAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [accessSubmitting, setAccessSubmitting] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([listAdminUsers(controller.signal), listOrgExecutionGrants(controller.signal),
      apiRequest<{ jobs: Array<{ resource: string; id: string; status: string; createdAt: string }> }>('/api/v1/admin/unowned-jobs', { signal: controller.signal })])
      .then(([userData, accessData, unowned]) => {
        setUsers(userData.users);
        setGrants(accessData.grants);
        setPolicies(accessData.policies);
        setLegacyPolicies(accessData.legacyPolicies);
        setUnownedJobs(unowned.jobs);
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
      setCreateOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '사용자를 생성하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const grantExecutionAccess = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const orgId = String(data.get('orgId') ?? '').trim();
    const userId = String(data.get('userId') ?? '');
    setAccessSubmitting(true);
    setError('');
    setMessage('');
    try {
      await grantOrgExecutionAccess(orgId, userId);
      const access = await listOrgExecutionGrants();
      setGrants(access.grants);
      setPolicies(access.policies);
      setLegacyPolicies(access.legacyPolicies);
      setMessage(`${orgId} org의 실제 배포 권한을 추가했습니다.`);
      form.reset();
      setGrantOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '실제 배포 권한을 추가하지 못했습니다.');
    } finally {
      setAccessSubmitting(false);
    }
  };

  const revokeExecutionAccess = async (grant: OrgExecutionGrant) => {
    setAccessSubmitting(true);
    setError('');
    setMessage('');
    try {
      await revokeOrgExecutionAccess(grant.orgId, grant.userId);
      const access = await listOrgExecutionGrants();
      setGrants(access.grants);
      setPolicies(access.policies);
      setLegacyPolicies(access.legacyPolicies);
      setMessage(`${grant.orgId} org의 실제 배포 권한을 회수했습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '실제 배포 권한을 회수하지 못했습니다.');
    } finally {
      setAccessSubmitting(false);
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
  const executionCandidates = users.filter((user) => !user.disabled && ['DEPLOYER', 'ADMIN'].includes(user.role));
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
      {unownedJobs.length > 0 && <section className="admin-org-access-panel" aria-labelledby="unowned-jobs-heading">
        <h2 id="unowned-jobs-heading">소유자 확인이 필요한 기존 작업</h2>
        <p>이 작업들은 현재 일반 사용자에게 공개되지 않습니다. 원본 기록으로 소유자를 검토하세요.</p>
        <div className="admin-org-access-list" role="list">{unownedJobs.map((job) => <article className="admin-org-access-row" key={`${job.resource}:${job.id}`} role="listitem">
          <div><strong>{job.resource} · {job.id}</strong><span>{job.status} · {job.createdAt}</span></div>
        </article>)}</div>
      </section>}
      <div className="admin-layout">
        <section className="workflow-panel admin-role-guide" aria-labelledby="role-guide-heading">
          <div className="admin-section-toolbar"><div className="panel-heading"><span className="card-icon icon-blue"><Icon name="shield" /></span><div><h2 id="role-guide-heading">역할 기준</h2></div></div></div>
          <details className="admin-role-details"><summary>역할별 기능과 보호 규칙 보기</summary>
          <dl><div><dt>VIEWER</dt><dd>결과와 실행 이력 조회</dd></div><div><dt>OPERATOR</dt><dd>비교, 업로드, Dry-run</dd></div><div><dt>DEPLOYER</dt><dd>OPERATOR 권한과 실제 배포</dd></div><div><dt>ADMIN</dt><dd>DEPLOYER 권한과 사용자 관리</dd></div></dl>
          <p><Icon name="key" />자기 역할·활성 상태 변경과 마지막 활성 ADMIN 제거는 차단됩니다.</p></details>
        </section>
        {createOpen && <ConnectionDialog title="사용자 생성" busy={submitting} onClose={() => setCreateOpen(false)}>
          <form className="admin-user-form" onSubmit={(event) => void createUser(event)}>
            <label><span>표시 이름</span><input name="displayName" maxLength={80} required placeholder="배포 운영자" /></label>
            <label><span>이메일</span><input name="email" type="email" autoComplete="off" required placeholder="operator@example.com" /></label>
            <label><span>역할</span><select name="role" defaultValue="VIEWER"><option value="VIEWER">VIEWER · 조회 전용</option><option value="OPERATOR">OPERATOR · 비교와 Dry-run</option><option value="DEPLOYER">DEPLOYER · 실제 배포</option><option value="ADMIN">ADMIN · 사용자 관리</option></select></label>
            <label><span>초기 비밀번호</span><input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="12자 이상" /></label>
            <p><Icon name="shield" />비밀번호 원문은 저장하지 않습니다. 생성 후 사용자에게 별도 안전 채널로 전달하세요.</p>
            <button className="button button-primary" type="submit" disabled={submitting}><Icon name={submitting ? 'refresh' : 'plus'} />{submitting ? '생성 중……' : '사용자 생성'}</button>
            {error && <p className="settings-error" role="alert">{error}</p>}
          </form>
        </ConnectionDialog>}
      </div>
      {(error || message) && !createOpen && !grantOpen && <p className={error ? 'admin-feedback admin-feedback-error' : 'admin-feedback'} role={error ? 'alert' : 'status'}>{error || message}</p>}
      <section className="admin-users-panel" aria-labelledby="admin-users-heading">
        <div className="admin-users-head"><div><h2 id="admin-users-heading">등록 사용자</h2><p>역할 변경은 다음 요청부터 반영되며, 비활성화하면 기존 세션도 종료됩니다.</p></div><div className="admin-heading-actions"><span>{users.length}명</span><button className="button button-primary" type="button" onClick={() => { setError(''); setCreateOpen(true); }}><Icon name="plus" />사용자 생성</button></div></div>
        {loading
          ? <p className="empty-runs">사용자 목록을 불러오는 중입니다.</p>
          : users.length === 0
            ? <p className="empty-runs">등록된 사용자가 없습니다.</p>
            : <div className="connection-table-scroll admin-table-scroll" role="region" aria-label="등록 사용자 표 영역" tabIndex={0}><table className="connection-table admin-table" aria-label="등록 사용자"><thead><tr><th scope="col">사용자</th><th scope="col">역할</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead><tbody>{users.map((user) => {
              const isCurrent = user.id === currentUser.id;
              const saving = savingIds.has(user.id);
              return <tr className={user.disabled ? 'admin-user-disabled' : ''} key={user.id}>
                <th scope="row"><strong>{user.displayName}{isCurrent && <i>나</i>}</strong><span>{user.email}</span><small>등록 {user.createdAt.slice(0, 10)}</small></th>
                <td><label className="admin-role-select"><select aria-label={`${user.displayName} 역할`} value={user.role} disabled={saving || isCurrent} onChange={(event) => void updateUser(user.id, { role: event.target.value as ApiUser['role'] })}><option value="VIEWER">VIEWER</option><option value="OPERATOR">OPERATOR</option><option value="DEPLOYER">DEPLOYER</option><option value="ADMIN">ADMIN</option></select></label></td>
                <td><span className={`admin-user-state ${user.disabled ? 'admin-user-state-disabled' : ''}`}><i />{user.disabled ? '비활성' : '활성'}</span></td>
                <td><button className={user.disabled ? 'admin-user-enable' : 'admin-user-disable'} type="button" disabled={saving || isCurrent} onClick={() => void updateUser(user.id, { disabled: !user.disabled })}>{saving ? '저장 중……' : user.disabled ? '활성화' : '비활성화'}</button></td>
              </tr>;
            })}</tbody></table></div>}
      </section>
      <section className="admin-org-access-panel" aria-labelledby="admin-org-access-heading">
        <div className="admin-users-head"><div><h2 id="admin-org-access-heading">대상 org 실제 배포 권한</h2><p>실제 Org ID별로 권한을 설정합니다. 정책이 없는 Org는 공용 모드에서 배포할 수 없습니다.</p></div><div className="admin-heading-actions"><span>{grants.length}건</span><button className="button button-primary" type="button" onClick={() => { setError(''); setGrantOpen(true); }}><Icon name="plus" />실행 권한 추가</button></div></div>
        {grantOpen && <ConnectionDialog title="실행 권한 추가" busy={accessSubmitting} onClose={() => setGrantOpen(false)}><form className="admin-org-access-form" onSubmit={(event) => void grantExecutionAccess(event)}>
          <label><span>대상 Salesforce Org ID</span><input name="orgId" required pattern="00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?" placeholder="00D로 시작하는 15자리 또는 18자리" /></label>
          <label><span>실행 사용자</span><select name="userId" required defaultValue="" disabled={executionCandidates.length === 0}><option value="" disabled>사용자를 선택하세요</option>{executionCandidates.map((user) => <option key={user.id} value={user.id}>{user.displayName} · {user.role}</option>)}</select></label>
          <button className="button button-primary" type="submit" disabled={accessSubmitting || executionCandidates.length === 0}><Icon name={accessSubmitting ? 'refresh' : 'key'} />{accessSubmitting ? '저장 중……' : '실행 권한 추가'}</button>
          {error && <p className="settings-error" role="alert">{error}</p>}
        </form></ConnectionDialog>}
        {policies.length === 0
          ? <p className="empty-runs">등록된 Org 실행 정책이 없습니다.</p>
          : <p className="empty-runs">{policies.filter((policy) => policy.grantCount === 0).length}개 Org는 정책이 활성화되어 있지만 허용 사용자가 없습니다.</p>}
        {legacyPolicies.length > 0 && <p className="settings-error">기존 별칭 정책 {legacyPolicies.length}개는 비활성 상태입니다: {legacyPolicies.map((policy) => policy.targetAlias).join(', ')}. 실제 Org ID를 확인해 다시 부여하세요.</p>}
        {grants.length === 0
          ? null
          : <div className="connection-table-scroll admin-table-scroll" role="region" aria-label="Org 실행 권한 표 영역" tabIndex={0}><table className="connection-table admin-table" aria-label="Org 실행 권한"><thead><tr><th scope="col">Org</th><th scope="col">사용자</th><th scope="col">부여일</th><th scope="col">관리</th></tr></thead><tbody>{grants.map((grant) => {
            const user = users.find((item) => item.id === grant.userId);
            return <tr key={`${grant.orgId}:${grant.userId}`}><th scope="row"><code>{grant.orgId}</code></th><td>{user === undefined ? grant.userId : `${user.displayName} · ${user.role}`}</td><td>{grant.createdAt.slice(0, 10)}</td><td><button type="button" disabled={accessSubmitting} onClick={() => void revokeExecutionAccess(grant)}>회수</button></td></tr>;
          })}</tbody></table></div>}
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
