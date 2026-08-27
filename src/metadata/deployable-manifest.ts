import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { SfudError } from '../core/errors.js';
import { listFiles, pathExists, writeJson } from '../core/files.js';
import { readProjectApiVersion } from '../core/request-workspace.js';
import type { SfClient } from '../salesforce/sf-client.js';
import type { SourceSpec } from '../sources/source-spec.js';
import type { MetadataTypeDescriptor } from './component-resolver.js';

interface DeployableManifestOptions {
  sources: readonly SourceSpec[];
  metadataTypes?: readonly string[];
  outputDirectory: string;
  commandProjectPath: string;
  sfClient: SfClient;
}

interface ParsedManifest {
  version?: string;
  types: Map<string, Set<string>>;
}

interface ProjectConfiguration {
  packageDirectories?: Array<{ path?: unknown }>;
}

export interface GeneratedDeployableManifest {
  manifestPath: string;
  metadataTypes: MetadataTypeDescriptor[];
  empty: boolean;
  sourceManifests: Array<{
    manifestPath: string;
    empty: boolean;
  }>;
}

export async function generateDeployableManifest(
  options: DeployableManifestOptions,
): Promise<GeneratedDeployableManifest> {
  if (options.sources.length === 0) {
    throw new SfudError('INVALID_ARGUMENT', '전체 메타데이터 manifest를 만들 비교 소스가 없습니다.');
  }

  const sourceDirectory = path.join(options.outputDirectory, 'sources');
  await mkdir(sourceDirectory, { recursive: true });
  const apiVersion = await readProjectApiVersion(options.commandProjectPath);
  const generated = await Promise.all(options.sources.map(async (source, index) => {
    const name = `${String(index + 1).padStart(2, '0')}-${source.kind}.xml`;
    const args = [
      'project',
      'generate',
      'manifest',
      '--name',
      name,
      '--output-dir',
      sourceDirectory,
      '--api-version',
      apiVersion,
    ];

    let metadataTypes: MetadataTypeDescriptor[];
    if (source.kind === 'org') {
      args.push('--from-org', source.alias);
      for (const metadataType of options.metadataTypes ?? []) {
        args.push('--metadata', metadataType);
      }
      await options.sfClient.runJson(args, {
        cwd: options.commandProjectPath,
        timeoutMs: 35 * 60 * 1000,
      });
      metadataTypes = parseMetadataTypes(await options.sfClient.runJson([
        'org',
        'list',
        'metadata-types',
        '--target-org',
        source.alias,
        '--api-version',
        apiVersion,
      ], { cwd: options.commandProjectPath, timeoutMs: 60_000 }));
    } else {
      const sourceDirectories = await readPackageDirectories(source.projectPath);
      for (const sourcePath of sourceDirectories) {
        args.push('--source-dir', sourcePath);
      }
      await options.sfClient.runJson(args, {
        cwd: source.projectPath,
        timeoutMs: 35 * 60 * 1000,
      });
      metadataTypes = await discoverLocalMetadataTypes(sourceDirectories);
    }

    const generatedPath = path.join(sourceDirectory, name);
    if (!(await pathExists(generatedPath))) {
      throw new SfudError(
        'SF_RESPONSE_INVALID',
        `Salesforce CLI가 manifest 파일을 생성하지 않았습니다: ${name}`,
      );
    }
    return { generatedPath, metadataTypes };
  }));

  const manifests = await Promise.all(generated.map(({ generatedPath }) => parseManifest(generatedPath)));
  const merged = filterManifestTypes(mergeManifests(manifests), options.metadataTypes);
  const outputPath = path.join(options.outputDirectory, 'package.xml');
  const metadataTypes = mergeMetadataTypes(generated.flatMap((entry) => entry.metadataTypes));
  const sourceManifests = generated.map(({ generatedPath }, index) => ({
    manifestPath: generatedPath,
    parsed: filterManifestTypes(manifests[index]!, options.metadataTypes),
  }));
  await Promise.all(sourceManifests.map(({ manifestPath, parsed }) =>
    writeFile(manifestPath, renderManifest(parsed, apiVersion), 'utf8')));
  await writeFile(outputPath, renderManifest(merged, apiVersion), 'utf8');
  await writeJson(path.join(options.outputDirectory, 'metadata-types.json'), metadataTypes);
  return {
    manifestPath: outputPath,
    metadataTypes,
    empty: isManifestEmpty(merged),
    sourceManifests: sourceManifests.map(({ manifestPath, parsed }) => ({
      manifestPath,
      empty: isManifestEmpty(parsed),
    })),
  };
}

function filterManifestTypes(
  manifest: ParsedManifest,
  selectedTypes: readonly string[] | undefined,
): ParsedManifest {
  if (selectedTypes === undefined || selectedTypes.length === 0) return manifest;
  const allowed = new Set(selectedTypes);
  return {
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    types: new Map([...manifest.types].filter(([type]) => allowed.has(type))),
  };
}

function parseMetadataTypes(value: unknown): MetadataTypeDescriptor[] {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.metadataObjects)) return [];
  return value.result.metadataObjects.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.directoryName !== 'string' || typeof entry.xmlName !== 'string') {
      return [];
    }
    return [{
      directoryName: entry.directoryName,
      xmlName: entry.xmlName,
      ...(typeof entry.suffix === 'string' ? { suffix: entry.suffix } : {}),
    }];
  });
}

function mergeMetadataTypes(values: readonly MetadataTypeDescriptor[]): MetadataTypeDescriptor[] {
  const unique = new Map<string, MetadataTypeDescriptor>();
  for (const value of values) {
    unique.set(`${value.directoryName}:${value.xmlName}:${value.suffix ?? ''}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName)
      || left.xmlName.localeCompare(right.xmlName)
      || (left.suffix ?? '').localeCompare(right.suffix ?? ''));
}

async function readPackageDirectories(projectPath: string): Promise<string[]> {
  const configurationPath = path.join(projectPath, 'sfdx-project.json');
  const configuration = await readProjectConfiguration(configurationPath);
  const directories = configuration.packageDirectories
    ?.map((entry) => typeof entry.path === 'string' ? entry.path.trim() : '')
    .filter((entry) => entry.length > 0) ?? [];
  if (directories.length === 0) {
    throw new SfudError(
      'INVALID_SOURCE',
      `packageDirectories가 없는 Salesforce DX 프로젝트입니다: ${projectPath}`,
    );
  }
  return directories.map((entry) => path.resolve(projectPath, entry));
}

async function discoverLocalMetadataTypes(
  sourceDirectories: readonly string[],
): Promise<MetadataTypeDescriptor[]> {
  const descriptors: MetadataTypeDescriptor[] = [];
  for (const sourceDirectory of sourceDirectories) {
    for (const relativePath of await listFiles(sourceDirectory)) {
      if (!relativePath.endsWith('-meta.xml')) continue;
      const metadataPath = stripStandardSourcePrefix(relativePath);
      const directoryName = metadataPath.split('/')[0];
      if (directoryName === undefined || directoryName.length === 0) continue;
      const xmlName = extractRootElement(await readFile(path.join(sourceDirectory, relativePath), 'utf8'));
      if (xmlName === undefined) continue;
      const sourcePath = metadataPath.slice(0, -'-meta.xml'.length);
      const extension = path.posix.extname(sourcePath);
      descriptors.push({
        directoryName,
        xmlName,
        ...(extension.length <= 1 ? {} : { suffix: extension.slice(1) }),
      });
    }
  }
  return mergeMetadataTypes(descriptors);
}

function stripStandardSourcePrefix(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[0] === 'main' && parts[1] === 'default'
    ? parts.slice(2).join('/')
    : relativePath;
}

function extractRootElement(xml: string): string | undefined {
  return xml.match(/<(?![?!/])(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)[\s>]/u)?.[1];
}

async function readProjectConfiguration(configurationPath: string): Promise<ProjectConfiguration> {
  try {
    return JSON.parse(await readFile(configurationPath, 'utf8')) as ProjectConfiguration;
  } catch (error) {
    throw new SfudError(
      'INVALID_SOURCE',
      `sfdx-project.json을 읽을 수 없습니다: ${configurationPath}`,
      { cause: error },
    );
  }
}

async function parseManifest(manifestPath: string): Promise<ParsedManifest> {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(await readFile(manifestPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.Package)) {
    throw new SfudError('SF_RESPONSE_INVALID', `생성된 manifest 형식이 올바르지 않습니다: ${manifestPath}`);
  }

  const result: ParsedManifest = { types: new Map() };
  if (typeof parsed.Package.version === 'string' || typeof parsed.Package.version === 'number') {
    result.version = String(parsed.Package.version);
  }
  for (const entry of asArray(parsed.Package.types)) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    const members = asArray(entry.members)
      .filter((member): member is string | number => typeof member === 'string' || typeof member === 'number')
      .map(String);
    result.types.set(entry.name, new Set(members));
  }
  return result;
}

function mergeManifests(manifests: readonly ParsedManifest[]): ParsedManifest {
  const merged: ParsedManifest = { types: new Map() };
  for (const manifest of manifests) {
    if (manifest.version !== undefined && (
      merged.version === undefined || Number(manifest.version) > Number(merged.version)
    )) {
      merged.version = manifest.version;
    }
    for (const [type, members] of manifest.types) {
      const mergedMembers = merged.types.get(type) ?? new Set<string>();
      for (const member of members) mergedMembers.add(member);
      merged.types.set(type, mergedMembers);
    }
  }
  return merged;
}

function isManifestEmpty(manifest: ParsedManifest): boolean {
  return [...manifest.types.values()].every((members) => members.size === 0);
}

function renderManifest(manifest: ParsedManifest, preferredVersion?: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
  ];
  for (const [type, members] of [...manifest.types].sort(([left], [right]) => left.localeCompare(right))) {
    if (members.size === 0) continue;
    lines.push('    <types>');
    for (const member of [...members].sort((left, right) => left.localeCompare(right))) {
      lines.push(`        <members>${escapeXml(member)}</members>`);
    }
    lines.push(`        <name>${escapeXml(type)}</name>`);
    lines.push('    </types>');
  }
  lines.push(`    <version>${escapeXml(preferredVersion ?? manifest.version ?? '67.0')}</version>`);
  lines.push('</Package>', '');
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

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
