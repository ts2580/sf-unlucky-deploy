import { downloadDiff, type DiffDownloadFormat } from './diff-download';

export function DiffDownload({ label, name, render, disabled = false, title }: {
  label: string;
  name: string;
  render: (format: DiffDownloadFormat) => string;
  disabled?: boolean;
  title?: string;
}) {
  return <select className="diff-download" aria-label={label} value="" disabled={disabled}
    title={title ?? '형식을 선택하면 바로 다운로드합니다.'}
    onChange={(event) => {
      const format = event.currentTarget.value;
      if (format !== 'csv' && format !== 'md' && format !== 'json') return;
      try { downloadDiff(render(format), name, format); }
      finally { event.currentTarget.value = ''; }
    }}>
    <option value="" disabled>{label}</option>
    <option value="csv">CSV</option>
    <option value="md">MD</option>
    <option value="json">JSON</option>
  </select>;
}
