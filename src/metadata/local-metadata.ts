import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { SfudError } from '../core/errors.js';
import { listFiles } from '../core/files.js';
import type { MetadataTypeDescriptor } from './component-resolver.js';

interface ProjectConfiguration {
  packageDirectories?: Array<{ path?: unknown }>;
}

export async function resolveLocalPackageDirectories(projectPath: string): Promise<string[]> {
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

  const projectRealPath = await realpath(projectPath);
  const resolved: string[] = [];
  for (const directory of directories) {
    let packageDirectory: string;
    try {
      packageDirectory = await realpath(path.resolve(projectRealPath, directory));
    } catch (error) {
      throw new SfudError(
        'INVALID_SOURCE',
        `존재하지 않는 packageDirectory가 포함되어 있습니다: ${directory}`,
        { cause: error },
      );
    }
    if (!isInside(projectRealPath, packageDirectory)) {
      throw new SfudError('INVALID_SOURCE', '프로젝트 외부 packageDirectory는 사용할 수 없습니다.');
    }
    resolved.push(packageDirectory);
  }
  return resolved;
}

export async function discoverLocalMetadataTypes(
  projectPath: string,
): Promise<MetadataTypeDescriptor[]> {
  const sourceDirectories = await resolveLocalPackageDirectories(projectPath);
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
  return mergeMetadataTypeDescriptors(descriptors);
}

export function mergeMetadataTypeDescriptors(
  values: readonly MetadataTypeDescriptor[],
): MetadataTypeDescriptor[] {
  const unique = new Map<string, MetadataTypeDescriptor>();
  for (const value of values) {
    unique.set(`${value.directoryName}:${value.xmlName}:${value.suffix ?? ''}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName)
      || left.xmlName.localeCompare(right.xmlName)
      || (left.suffix ?? '').localeCompare(right.suffix ?? ''));
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

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
