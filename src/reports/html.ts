import type { ComparisonResult, FileDifference } from '../metadata/comparator.js';
import type { XmlChange } from '../metadata/xml-diff.js';

export function renderHtmlReport(result: ComparisonResult): string {
  const changed = result.components.filter((component) => component.status !== 'IDENTICAL');
  const components = changed.length === 0
    ? '<p class="empty" data-testid="empty-result">두 소스의 메타데이터가 동일합니다.</p>'
    : changed
        .map(
          (component) => `
          <details class="component status-${component.status.toLowerCase()}" open data-testid="component">
            <summary>
              <span class="badge">${component.status}</span>
              <strong>${escapeHtml(component.type)}</strong>
              <code>${escapeHtml(component.fullName)}</code>
            </summary>
            <div class="component-body">
              ${component.files
                .filter((file) => file.status !== 'IDENTICAL')
                .map(renderFile)
                .join('')}
            </div>
          </details>`,
        )
        .join('');
  const semanticEqualFiles = result.components.flatMap((component) =>
    component.files.flatMap((file) =>
      file.rawContentChanged === true && file.xmlSemanticStatus === 'EQUAL'
        ? [`<li><strong>${escapeHtml(component.type)}</strong> · <code>${escapeHtml(component.fullName)}</code> · <code>${escapeHtml(file.path)}</code> · ${xmlPolicyLabel(file)}</li>`]
        : []));

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Salesforce 메타데이터 비교 결과</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f6fb; --panel: #fff; --text: #172033; --muted: #657089; --line: #dce2ef; --added: #18794e; --removed: #c23434; --modified: #9a6700; --same: #64748b; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100% - 32px)); margin: 40px auto 72px; }
    h1 { margin: 0 0 8px; font-size: clamp(24px, 4vw, 38px); letter-spacing: -.04em; }
    .subtitle { color: var(--muted); margin: 0 0 28px; }
    .sources { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .source, .card, .component { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 8px 28px rgba(31, 42, 68, .06); }
    .source { padding: 16px; min-width: 0; }
    .source span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .source code { display: block; overflow-wrap: anywhere; margin-top: 5px; }
    .summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin: 20px 0 30px; }
    .card { padding: 18px; }
    .card span { display: block; color: var(--muted); font-size: 12px; }
    .card strong { display: block; margin-top: 5px; font-size: 26px; }
    .component { margin: 12px 0; overflow: clip; }
    .component summary { cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 16px 18px; }
    .component summary code { margin-left: auto; overflow-wrap: anywhere; text-align: right; }
    .component-body { border-top: 1px solid var(--line); padding: 4px 18px 18px; }
    .file { padding-top: 16px; }
    .file h3 { font-size: 14px; margin: 0 0 10px; overflow-wrap: anywhere; }
    .badge { border-radius: 999px; color: #fff; font-size: 11px; font-weight: 800; padding: 3px 8px; }
    .status-added .badge { background: var(--added); }
    .status-removed .badge { background: var(--removed); }
    .status-modified .badge { background: var(--modified); }
    table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; white-space: pre-wrap; }
    th { color: var(--muted); font-size: 12px; }
    pre { margin: 10px 0 0; padding: 14px; overflow: auto; border-radius: 10px; background: #111827; color: #e5e7eb; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .hash { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .warnings { border-left: 4px solid var(--modified); padding: 10px 14px; background: color-mix(in srgb, var(--modified) 10%, transparent); }
    .semantic-equal { margin: 16px 0; border-left: 4px solid var(--added); padding: 10px 14px; background: color-mix(in srgb, var(--added) 10%, transparent); }
    .empty { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 28px; text-align: center; }
    @media (max-width: 720px) { .sources { grid-template-columns: 1fr; } .summary { grid-template-columns: repeat(2, 1fr); } .component summary { align-items: flex-start; flex-wrap: wrap; } .component summary code { width: 100%; margin-left: 0; text-align: left; } }
    @media (prefers-color-scheme: dark) { :root { --bg: #0e1422; --panel: #151d2e; --text: #eef2ff; --muted: #a6b0c5; --line: #2a354b; --added: #3ba979; --removed: #e05a5a; --modified: #d6a329; } }
  </style>
</head>
<body>
  <main>
    <h1 data-testid="report-title">Salesforce 메타데이터 비교 결과</h1>
    <p class="subtitle">${escapeHtml(result.generatedAt)} · ${result.strict ? 'strict' : 'metadata-aware'} 비교</p>
    <section class="sources" aria-label="비교 소스">
      <div class="source"><span>LEFT</span><code data-testid="left-source">${escapeHtml(result.left.displayName)}</code></div>
      <div class="source"><span>RIGHT</span><code data-testid="right-source">${escapeHtml(result.right.displayName)}</code></div>
    </section>
    <section class="summary" aria-label="비교 요약" data-testid="summary">
      ${summaryCard('전체', result.summary.total)}
      ${summaryCard('추가', result.summary.added)}
      ${summaryCard('삭제', result.summary.removed)}
      ${summaryCard('변경', result.summary.modified)}
      ${summaryCard('동일', result.summary.identical)}
    </section>
    ${
      result.warnings.length > 0
        ? `<aside class="warnings"><strong>주의</strong><ul>${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></aside>`
        : ''
    }
    ${semanticEqualFiles.length > 0
      ? `<aside class="semantic-equal" data-testid="semantic-equal"><strong>원문이 다른 semantic 동일 XML</strong><ul>${semanticEqualFiles.join('')}</ul></aside>`
      : ''}
    <section aria-label="변경된 컴포넌트">
      ${components}
    </section>
  </main>
</body>
</html>
`;
}

function renderFile(file: FileDifference): string {
  const xml = file.xmlChanges && file.xmlChanges.length > 0
    ? `<table><thead><tr><th>상태</th><th>경로</th><th>이전 값</th><th>새 값</th></tr></thead><tbody>${file.xmlChanges.map(renderXmlChange).join('')}</tbody></table>`
    : '';
  const diff = file.unifiedDiff ? `<pre>${escapeHtml(file.unifiedDiff)}</pre>` : '';
  const binary = file.kind === 'binary'
    ? `<p class="hash">LEFT ${escapeHtml(file.leftSha256 ?? '없음')} (${file.leftSize ?? 0} bytes)<br>RIGHT ${escapeHtml(file.rightSha256 ?? '없음')} (${file.rightSize ?? 0} bytes)</p>`
    : '';
  const semantic = file.rawContentChanged === true && file.xmlSemanticStatus !== undefined
    ? `<p>XML 의미 ${file.xmlSemanticStatus === 'EQUAL' ? '동일' : '변경'} · ${xmlPolicyLabel(file)} · 원문 SHA-256 다름</p>`
    : '';
  return `<article class="file" data-testid="changed-file"><h3>${file.status} · ${escapeHtml(file.path)}</h3>${semantic}${xml}${diff}${binary}</article>`;
}

function xmlPolicyLabel(file: FileDifference): string {
  return file.xmlComparisonPolicy === 'REGISTERED' ? 'metadata type 등록 정책' : 'generic 정책';
}

function renderXmlChange(change: XmlChange): string {
  return `<tr><td>${change.kind}</td><td><code>${escapeHtml(change.path)}</code></td><td>${escapeHtml(change.before ?? '')}</td><td>${escapeHtml(change.after ?? '')}</td></tr>`;
}

function summaryCard(label: string, value: number): string {
  return `<div class="card"><span>${label}</span><strong data-summary="${escapeHtml(label)}">${value}</strong></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#039;');
}
