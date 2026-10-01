import { useState } from 'react';
import { GitAliasInputSchema } from '../../../src/api/git-contracts';
import { apiRequest } from '../api-client';
import { errorMessage } from './api';

export function GitAliasEditor({ alias, endpoint, disabled, onSaved, initiallyEditing = false }: {
  alias?: string; endpoint: string; disabled: boolean; onSaved(): void | Promise<void>; initiallyEditing?: boolean;
}) {
  const [editing, setEditing] = useState(initiallyEditing);
  const [value, setValue] = useState(alias ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (disabled || busy) return;
    setBusy(true); setError('');
    try {
      await apiRequest(endpoint, { method: 'PATCH', csrf: true, body: { alias: value.trim() }, requestSchema: GitAliasInputSchema });
      await onSaved(); setEditing(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div className="git-alias-editor">
    {editing ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>별칭<input value={value} onChange={(event) => setValue(event.target.value)} maxLength={80}
        disabled={disabled || busy} autoComplete="off" /></label>
      <p>비워서 저장하면 원래 이름을 표시합니다. 저장소 주소와 인증 정보는 바뀌지 않습니다.</p>
      <div className="git-actions"><button type="submit" className="small-button" disabled={disabled || busy}>{busy ? '저장 중…' : '별칭 저장'}</button>
        <button type="button" className="small-button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>취소</button></div>
    </form> : <button type="button" className="small-button" disabled={disabled} onClick={() => { setValue(alias ?? ''); setError(''); setEditing(true); }}>
      {alias ? '별칭 변경' : '별칭 설정'}</button>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </div>;
}
