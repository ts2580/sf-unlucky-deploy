import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { readProjectApiVersion } from '../core/request-workspace.js';

export interface SelectedMetadataComponent {
  type: string;
  fullName: string;
}

export function normalizeSelectedComponents(value: readonly SelectedMetadataComponent[]): SelectedMetadataComponent[] {
  if (value.length === 0 || value.length > 2_000) {
    throw new SfudError('INVALID_ARGUMENT', '배포 대상은 1개부터 2,000개까지 선택할 수 있습니다.');
  }
  const unique = new Map<string, SelectedMetadataComponent>();
  for (const component of value) {
    const type = component.type.trim();
    const fullName = component.fullName.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(type)) {
      throw new SfudError('INVALID_ARGUMENT', `Salesforce metadata type이 올바르지 않습니다: ${type}`);
    }
    if (fullName.length === 0 || fullName.length > 512 || /[\u0000-\u001f\u007f]/u.test(fullName)) {
      throw new SfudError('INVALID_ARGUMENT', `Salesforce metadata 이름이 올바르지 않습니다: ${fullName}`);
    }
    unique.set(`${type}\u0000${fullName}`, { type, fullName });
  }
  return [...unique.values()].sort((left, right) =>
    left.type.localeCompare(right.type) || left.fullName.localeCompare(right.fullName));
}

export async function writeSelectedManifest(options: {
  components: readonly SelectedMetadataComponent[];
  projectPath: string;
  runsDirectory: string;
}): Promise<{ manifestPath: string; components: SelectedMetadataComponent[] }> {
  const components = normalizeSelectedComponents(options.components);
  const directory = path.join(options.runsDirectory, 'selected-manifests');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, `${randomUUID()}.xml`);
  const version = await readProjectApiVersion(options.projectPath);
  await writeFile(manifestPath, renderSelectedManifest(components, version), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return { manifestPath, components };
}

export function renderSelectedManifest(
  components: readonly SelectedMetadataComponent[],
  apiVersion = '67.0',
): string {
  const normalized = normalizeSelectedComponents(components);
  const grouped = new Map<string, string[]>();
  for (const component of normalized) {
    const members = grouped.get(component.type) ?? [];
    members.push(component.fullName);
    grouped.set(component.type, members);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
  ];
  for (const [type, members] of grouped) {
    lines.push('    <types>');
    for (const member of members) lines.push(`        <members>${escapeXml(member)}</members>`);
    lines.push(`        <name>${escapeXml(type)}</name>`);
    lines.push('    </types>');
  }
  lines.push(`    <version>${escapeXml(apiVersion)}</version>`, '</Package>', '');
  return lines.join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
