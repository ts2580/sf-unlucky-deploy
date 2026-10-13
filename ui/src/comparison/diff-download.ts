import type { ComparisonFileDifference } from '../ComparisonFileDiff';
import type { ComparisonComponent, ComparisonJobResponse } from './api';
import { renderComparisonMarkdown, renderFileDiffMarkdown, type DiffContext } from './markdown-download';

export type DiffDownloadFormat = 'csv' | 'md' | 'json';

export function renderComparisonDownload(job: ComparisonJobResponse, components: ComparisonComponent[], sourceSide: DiffContext['sourceSide'], format: DiffDownloadFormat): string {
  if (format === 'md') return renderComparisonMarkdown(job, components, sourceSide);
  const source = sourceSide === 'after' ? job.right : job.left;
  const target = sourceSide === 'after' ? job.left : job.right;
  const context = { sourceLabel: source.label, targetLabel: target.label, sourceSide };
  const metadata = {
    comparisonId: job.id, manifest: job.manifest,
    comparedAt: job.completedAt ?? job.updatedAt ?? job.createdAt ?? null,
    scope: 'filtered-components-all-pages', componentCount: components.length,
    source, target, ...context, summary: job.result?.summary, warnings: job.result?.warnings ?? [],
  };
  if (format === 'json') return json({ ...metadata, components });
  return csv(components.flatMap((component) => {
    const info = { ...metadata, componentKey: component.key, componentType: component.type, componentName: component.fullName, componentStatus: component.status };
    return component.files.length === 0 ? [{ ...info, ...fileColumns(undefined, context) }]
      : component.files.map((file) => ({ ...info, ...fileColumns(file, context) }));
  }), { ...metadata, componentKey: '', componentType: '', componentName: '', componentStatus: '', ...fileColumns(undefined, context) });
}

export function renderFileDiffDownload(file: ComparisonFileDifference, context: DiffContext, format: DiffDownloadFormat): string {
  if (format === 'md') return renderFileDiffMarkdown(file, context);
  if (format === 'json') return json({ ...context, file });
  const row = { ...context, ...fileColumns(file, context) };
  return csv([row], row);
}

function fileColumns(file: ComparisonFileDifference | undefined, context: DiffContext) {
  const sourceIsBefore = context.sourceSide === 'before';
  return {
    path: file?.path, status: file?.status, kind: file?.kind, unifiedDiff: file?.unifiedDiff,
    xmlChanges: file?.xmlChanges?.map((change) => ({ ...change,
      source: change[context.sourceSide], target: change[sourceIsBefore ? 'after' : 'before'],
    })),
    xmlSemanticStatus: file?.xmlSemanticStatus, xmlComparisonPolicy: file?.xmlComparisonPolicy,
    rawContentChanged: file?.rawContentChanged, diffTruncated: file?.diffTruncated,
    sourceSha256: sourceIsBefore ? file?.leftSha256 : file?.rightSha256,
    targetSha256: sourceIsBefore ? file?.rightSha256 : file?.leftSha256,
    sourceSize: sourceIsBefore ? file?.leftSize : file?.rightSize,
    targetSize: sourceIsBefore ? file?.rightSize : file?.leftSize,
  };
}

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

function csv(rows: Record<string, unknown>[], template: Record<string, unknown>): string {
  const columns = Object.keys(template);
  return '\uFEFF' + [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Quoting alone does not stop spreadsheet applications from evaluating formulas.
  if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

export function downloadDiff(content: string, name: string, format: DiffDownloadFormat): void {
  const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '-').replace(/[.\s]+$/gu, '').slice(0, 180) || 'diff';
  const mime = { csv: 'text/csv', md: 'text/markdown', json: 'application/json' }[format];
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url; link.download = `${safeName}.${format}`;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
