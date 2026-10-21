import { useState } from 'react';
import { GitConnectionResponseSchema, GitRepositorySelectionSchema, type GitConnection } from '../../../src/api/git-contracts';
import { apiRequest } from '../api-client';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { errorMessage } from './api';
import { GitRepositoryPicker } from './GitRepositoryPicker';

export function GitRepositoryConnectDialog({ connection, canEdit, onConnected, onClose }: {
  connection: GitConnection; canEdit: boolean; onConnected(): void; onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connect = async (repositoryPath: string) => {
    if (!canEdit || busy) return;
    setBusy(true); setError('');
    try {
      await apiRequest(`/api/v1/git/connections/${encodeURIComponent(connection.id)}/repositories`, {
        method: 'POST', csrf: true, body: { repositoryPath }, requestSchema: GitRepositorySelectionSchema,
        responseSchema: GitConnectionResponseSchema,
      });
      onConnected();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <ConnectionDialog title="저장소 선택" className="git-import-dialog" busy={busy} onClose={onClose}>
    <p>{connection.alias ?? connection.displayName} 계정에서 연결할 저장소를 선택하세요. 브랜치는 비교 화면에서 선택합니다.</p>
    <GitRepositoryPicker connection={connection} disabled={!canEdit || busy} onSelect={(path) => void connect(path)} />
    {busy && <p role="status">저장소 연결 중……</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </ConnectionDialog>;
}
