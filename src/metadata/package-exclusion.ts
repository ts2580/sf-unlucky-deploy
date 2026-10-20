import { SfudError } from '../core/errors.js';
import type { SfClient } from '../salesforce/sf-client.js';
import type { SourceSpec } from '../sources/source-spec.js';
import type { InstalledPackage } from '../api/package-contracts.js';
import type { PackageComponent } from '../api/package-contracts.js';
import { retrievePackageComponents } from './package-components.js';

export interface PackageExclusion {
  selectedPackages?: Array<{ id: string; name: string }>;
  namespaces: string[];
  unnamespacedPackages: string[];
  componentKeys?: string[];
}

export type PackageComponentResolver = (
  entry: InstalledPackage, alias: string, cwd: string, signal: AbortSignal | undefined, required: boolean,
) => Promise<PackageComponent[] | undefined>;

export async function resolvePackageExclusion(
  sources: readonly SourceSpec[], sfClient: SfClient, cwd: string, signal?: AbortSignal, selectedIds?: readonly string[],
  componentResolver?: PackageComponentResolver,
): Promise<PackageExclusion> {
  const packages = await listInstalledPackages(sources, sfClient, cwd, signal);
  const selected = selectedIds === undefined ? packages : selectedIds.map((id) => {
    const entry = packages.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new SfudError('INVALID_ARGUMENT', `선택한 패키지가 현재 Org에 설치되어 있지 않습니다: ${id}`);
    return entry;
  });
  const exactIds = new Set<string>();
  const componentKeys = new Set<string>();
  if (selectedIds !== undefined) for (const entry of selected) {
    // Unique namespaces need no component lookup; shared namespaces keep exact membership.
    if (entry.namespace !== null && !packages.some((other) => other.id !== entry.id && other.namespace === entry.namespace)) continue;
    const required = entry.exclusionUnavailableReason !== undefined;
    if (packages.some((other) => other.id !== entry.id && other.name === entry.name
      && other.orgAliases.some((alias) => entry.orgAliases.includes(alias)))) {
      throw new SfudError('INVALID_ARGUMENT', '같은 이름의 패키지가 있어 구성요소를 안전하게 구분할 수 없습니다.');
    }
    const results = await Promise.all(entry.orgAliases.map((alias) => componentResolver === undefined
      ? required ? retrievePackageComponents(entry.name, alias, sfClient, cwd, signal) : undefined
      : componentResolver(entry, alias, cwd, signal, required)));
    if (results.every((components) => components !== undefined)) {
      exactIds.add(entry.id);
      for (const components of results) for (const component of components!) componentKeys.add(`${component.type}:${component.fullName}`);
    } else if (required) throw new SfudError('INVALID_ARGUMENT', `${entry.name}: 패키지 구성요소를 먼저 로딩하세요.`);
  }
  return {
    namespaces: [...new Set(selected.flatMap((entry) => entry.namespace === null || exactIds.has(entry.id) ? [] : [entry.namespace]))].sort(),
    unnamespacedPackages: selected.filter((entry) => entry.namespace === null && !exactIds.has(entry.id)).map((entry) => entry.name).sort(),
    ...(exactIds.size === 0 ? {} : { componentKeys: [...componentKeys].sort() }),
    ...(selectedIds === undefined ? {} : { selectedPackages: selected.map(({ id, name }) => ({ id, name })) }),
  };
}

export function validateExcludedPackageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200
    || !value.every((id) => typeof id === 'string' && /^033[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/u.test(id))) {
    throw new SfudError('INVALID_ARGUMENT', '제외 패키지는 설치 패키지 ID 목록이어야 합니다 (최대 200개).');
  }
  return [...new Set(value as string[])].sort();
}

export async function listInstalledPackages(
  sources: readonly SourceSpec[], sfClient: SfClient, cwd: string, signal?: AbortSignal,
): Promise<InstalledPackage[]> {
  const aliases = [...new Set(sources.flatMap((source) => source.kind === 'org' ? [source.alias] : []))];
  if (aliases.length === 0) {
    throw new SfudError('INVALID_ARGUMENT', '설치 패키지 제외에는 연결된 Salesforce Org가 하나 이상 필요합니다.');
  }
  const packages = new Map<string, InstalledPackage>();
  for (const alias of aliases) {
    const raw = await sfClient.runJson(['package', 'installed', 'list', '--target-org', alias], {
      cwd, timeoutMs: 60_000, ...(signal === undefined ? {} : { signal }),
    });
    if (!isRecord(raw) || !Array.isArray(raw.result)) {
      throw new SfudError('SF_RESPONSE_INVALID', '설치 패키지 목록을 확인하지 못했습니다. 제외 없이 비교를 계속하지 않습니다.');
    }
    for (const entry of raw.result) {
      if (!isRecord(entry) || typeof entry.SubscriberPackageName !== 'string'
        || typeof entry.SubscriberPackageId !== 'string'
        || !/^033[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/u.test(entry.SubscriberPackageId)) {
        throw new SfudError('SF_RESPONSE_INVALID', '설치 패키지 목록 형식이 올바르지 않습니다.');
      }
      const namespace = entry.SubscriberPackageNamespace;
      if (namespace !== null && namespace !== ''
        && !(typeof namespace === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/u.test(namespace))) {
        throw new SfudError('SF_RESPONSE_INVALID', '설치 패키지 네임스페이스를 확인하지 못했습니다.');
      }
      const normalizedNamespace = namespace === '' ? null : namespace as string | null;
      const existing = packages.get(entry.SubscriberPackageId);
      if (existing !== undefined && existing.namespace !== normalizedNamespace) {
        throw new SfudError('SF_RESPONSE_INVALID', '같은 패키지의 네임스페이스 정보가 Org마다 다릅니다.');
      }
      packages.set(entry.SubscriberPackageId, {
        id: entry.SubscriberPackageId, name: entry.SubscriberPackageName, namespace: normalizedNamespace,
        orgAliases: [...(existing?.orgAliases ?? []), alias].sort(),
        ...(entry.SubscriberPackageVersionId === undefined && existing?.versionIds === undefined ? {} : {
          versionIds: { ...existing?.versionIds,
            ...(typeof entry.SubscriberPackageVersionId === 'string' && /^04t[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/u.test(entry.SubscriberPackageVersionId)
              ? { [alias]: entry.SubscriberPackageVersionId } : {}),
          },
        }),
      });
    }
  }
  const result = [...packages.values()];
  for (const entry of result) {
    if (entry.namespace === null) entry.exclusionUnavailableReason = '개별 제외하려면 패키지 로딩으로 구성요소를 조회하세요.';
    else if (result.some((other) => other.id !== entry.id && other.namespace === entry.namespace)) {
      entry.exclusionUnavailableReason = '네임스페이스를 공유합니다. 패키지 로딩으로 구성요소를 조회하세요.';
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function belongsToPackage(fullName: string, namespaces: readonly string[], type = ''): boolean {
  // A managed parent does not make a locally created child package-owned.
  const childTypes = new Set(['CustomField', 'ValidationRule', 'FieldSet', 'RecordType',
    'ListView', 'WebLink', 'BusinessProcess', 'CompactLayout', 'SharingReason', 'CustomMetadata']);
  const folderTypes = new Set(['Report', 'Dashboard', 'EmailTemplate', 'Document']);
  const member = type === 'Layout' ? fullName.split('-').slice(1).join('-')
    : childTypes.has(type) ? fullName.split('.').at(-1)
      : folderTypes.has(type) ? fullName.split('/').at(-1)
        : /[./]/u.test(fullName) ? undefined : fullName;
  return member !== undefined && namespaces.some((namespace) => member.startsWith(`${namespace}__`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
