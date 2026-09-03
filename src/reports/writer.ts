import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJson } from '../core/files.js';
import type { ComparisonResult } from '../metadata/comparator.js';
import { renderHtmlReport } from './html.js';
import { renderMarkdownReport } from './markdown.js';

export interface ReportPaths {
  directory: string;
  markdown: string;
  json: string;
  diff: string;
  html: string;
  checksums: string;
}

export async function writeComparisonReports(
  result: ComparisonResult,
  reportDirectory: string,
): Promise<ReportPaths> {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await chmod(reportDirectory, 0o700);
  const paths: ReportPaths = {
    directory: reportDirectory,
    markdown: path.join(reportDirectory, 'summary.md'),
    json: path.join(reportDirectory, 'summary.json'),
    diff: path.join(reportDirectory, 'content.diff'),
    html: path.join(reportDirectory, 'report.html'),
    checksums: path.join(reportDirectory, 'checksums.json'),
  };

  await Promise.all([
    writeSecureText(paths.markdown, renderMarkdownReport(result)),
    writeJson(paths.json, result),
    writeSecureText(paths.diff, renderContentDiff(result)),
    writeSecureText(paths.html, renderHtmlReport(result)),
    writeJson(paths.checksums, {
      manifestSha256: result.left.manifestSha256,
      leftPayloadSha256: result.left.payloadSha256,
      rightPayloadSha256: result.right.payloadSha256,
    }),
  ]);

  return paths;
}

async function writeSecureText(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
}

function renderContentDiff(result: ComparisonResult): string {
  const lines: string[] = [];
  for (const component of result.components) {
    for (const file of component.files) {
      if (file.rawContentChanged === true && file.xmlSemanticStatus === 'EQUAL') {
        const policy = file.xmlComparisonPolicy === 'REGISTERED' ? 'metadata type 등록' : 'generic';
        lines.push(`# XML SEMANTIC EQUAL ${component.type}:${component.fullName}`);
        lines.push(`## RAW SHA-256 DIFFERENT ${file.path} (${policy} 정책)`, '');
      }
    }
  }
  for (const component of result.components.filter((candidate) => candidate.status !== 'IDENTICAL')) {
    lines.push(`# ${component.status} ${component.type}:${component.fullName}`);
    for (const file of component.files.filter((candidate) => candidate.status !== 'IDENTICAL')) {
      lines.push(`## ${file.status} ${file.path}`);
      if (file.unifiedDiff) {
        lines.push(file.unifiedDiff.trimEnd());
      }
      for (const change of file.xmlChanges ?? []) {
        if (change.kind === 'ADDED') {
          lines.push(`+ ${change.path}: ${change.after ?? ''}`);
        } else if (change.kind === 'REMOVED') {
          lines.push(`- ${change.path}: ${change.before ?? ''}`);
        } else {
          lines.push(`~ ${change.path}`);
          lines.push(`- ${change.before ?? ''}`);
          lines.push(`+ ${change.after ?? ''}`);
        }
      }
      if (file.kind === 'binary') {
        lines.push(`- SHA-256 ${file.leftSha256 ?? '없음'}`);
        lines.push(`+ SHA-256 ${file.rightSha256 ?? '없음'}`);
      }
      lines.push('');
    }
  }
  return lines.length === 0 ? '# 차이 없음\n' : `${lines.join('\n').trimEnd()}\n`;
}
