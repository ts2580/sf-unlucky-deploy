import type { ReactNode } from 'react';

interface ConnectionRow {
  id: string;
  name: ReactNode;
  target: ReactNode;
  connected: boolean;
  status: string;
  statusDetail?: ReactNode;
  actions: ReactNode;
  onEdit?: () => void;
  editDisabled?: boolean;
}

export function ConnectionTable({ label, rows, emptyMessage, refreshing, disabled, onRefresh }: {
  label: string;
  rows: ConnectionRow[];
  emptyMessage: string;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  return <>
    <div className="connection-list-toolbar">
      <span>연결 <strong>{rows.length}</strong>개</span>
      <button type="button" className="small-button" disabled={disabled || refreshing} onClick={onRefresh}>
        {refreshing ? '새로고침 중……' : '새로고침'}
      </button>
    </div>
    <div className="connection-table-scroll" role="region" aria-label={`${label} 표 영역`} tabIndex={0}>
      <table className="connection-table" aria-label={label}>
        <colgroup><col className="connection-name-column" /><col className="connection-target-column" /><col className="connection-status-column" /><col className="connection-actions-column" /></colgroup>
        <thead><tr><th scope="col">연결 이름</th><th scope="col">대상</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>
        <tbody>{rows.length === 0
          ? <tr><td colSpan={4} className="connection-table-empty">{emptyMessage}</td></tr>
          : rows.map((row) => <tr key={row.id} className={row.onEdit && !row.editDisabled ? 'connection-editable-row' : undefined}
            onClick={(event) => {
              if (disabled || row.editDisabled || !row.onEdit || !(event.target instanceof HTMLElement)
                || event.target.closest('button, input, select, textarea, a, form')) return;
              row.onEdit();
            }}>
            <th scope="row">{row.onEdit
              ? <button type="button" className="connection-name-button connection-cell-content" disabled={disabled || row.editDisabled} onClick={row.onEdit}>{row.name}</button>
              : <div className="connection-cell-content">{row.name}</div>}</th>
            <td><div className="connection-cell-content">{row.target}</div></td>
            <td><div className="connection-cell-content"><span className={`connection-state ${row.connected ? 'connection-state-ready' : 'connection-state-warning'}`}>{row.status}</span>{row.statusDetail}</div></td>
            <td><div className="connection-table-actions">{row.actions}</div></td>
          </tr>)}</tbody>
      </table>
    </div>
  </>;
}
