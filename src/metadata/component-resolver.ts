import path from 'node:path';

import { listFiles } from '../core/files.js';

export interface MetadataComponent {
  key: string;
  type: string;
  fullName: string;
  files: string[];
}

interface MetadataTypeRule {
  type: string;
  suffix?: string;
}

const TYPE_RULES: Readonly<Record<string, MetadataTypeRule>> = {
  applications: { type: 'CustomApplication', suffix: '.app' },
  appMenus: { type: 'AppMenu', suffix: '.appMenu' },
  approvalProcesses: { type: 'ApprovalProcess', suffix: '.approvalProcess' },
  assignmentRules: { type: 'AssignmentRules', suffix: '.assignmentRules' },
  autoResponseRules: { type: 'AutoResponseRules', suffix: '.autoResponseRules' },
  classes: { type: 'ApexClass', suffix: '.cls' },
  components: { type: 'ApexComponent', suffix: '.component' },
  customMetadata: { type: 'CustomMetadata', suffix: '.md' },
  duplicateRules: { type: 'DuplicateRule', suffix: '.duplicateRule' },
  flexipages: { type: 'FlexiPage', suffix: '.flexipage' },
  flows: { type: 'Flow', suffix: '.flow' },
  globalValueSets: { type: 'GlobalValueSet', suffix: '.globalValueSet' },
  labels: { type: 'CustomLabels', suffix: '.labels' },
  layouts: { type: 'Layout', suffix: '.layout' },
  namedCredentials: { type: 'NamedCredential', suffix: '.namedCredential' },
  objects: { type: 'CustomObject', suffix: '.object' },
  objectTranslations: { type: 'CustomObjectTranslation', suffix: '.objectTranslation' },
  pages: { type: 'ApexPage', suffix: '.page' },
  permissionsets: { type: 'PermissionSet', suffix: '.permissionset' },
  profiles: { type: 'Profile', suffix: '.profile' },
  remoteSiteSettings: { type: 'RemoteSiteSetting', suffix: '.remoteSite' },
  reports: { type: 'Report', suffix: '.report' },
  dashboards: { type: 'Dashboard', suffix: '.dashboard' },
  staticresources: { type: 'StaticResource', suffix: '.resource' },
  tabs: { type: 'CustomTab', suffix: '.tab' },
  triggers: { type: 'ApexTrigger', suffix: '.trigger' },
};

export async function resolveMetadataComponents(packageRoot: string): Promise<Map<string, MetadataComponent>> {
  const components = new Map<string, MetadataComponent>();

  for (const relativePath of await listFiles(packageRoot)) {
    if (relativePath === 'package.xml') {
      continue;
    }

    const identity = resolveIdentity(relativePath);
    const existing = components.get(identity.key);
    if (existing) {
      existing.files.push(relativePath);
    } else {
      components.set(identity.key, {
        ...identity,
        files: [relativePath],
      });
    }
  }

  for (const component of components.values()) {
    component.files.sort((left, right) => left.localeCompare(right));
  }

  return components;
}

function resolveIdentity(relativePath: string): Omit<MetadataComponent, 'files'> {
  const parts = relativePath.split('/');
  const directory = parts[0] ?? 'unknown';

  if ((directory === 'lwc' || directory === 'aura') && parts.length >= 2) {
    const fullName = parts[1]!;
    const type = directory === 'lwc' ? 'LightningComponentBundle' : 'AuraDefinitionBundle';
    return { type, fullName, key: `${type}:${fullName}` };
  }

  if ((directory === 'experiences' || directory === 'experienceBundles') && parts.length >= 2) {
    const fullName = parts[1]!;
    return { type: 'ExperienceBundle', fullName, key: `ExperienceBundle:${fullName}` };
  }

  const rule = TYPE_RULES[directory];
  if (rule) {
    const fullName = resolveFullName(parts.slice(1).join('/'), rule.suffix);
    return { type: rule.type, fullName, key: `${rule.type}:${fullName}` };
  }

  const fullName = stripMetadataSuffix(parts.slice(1).join('/') || relativePath);
  const type = `Unknown(${directory})`;
  return { type, fullName, key: `${type}:${fullName}` };
}

function resolveFullName(relativeWithinType: string, suffix?: string): string {
  const withoutMetaSuffix = relativeWithinType.endsWith('-meta.xml')
    ? relativeWithinType.slice(0, -'-meta.xml'.length)
    : relativeWithinType;

  if (suffix && withoutMetaSuffix.endsWith(suffix)) {
    return withoutMetaSuffix.slice(0, -suffix.length);
  }

  return stripMetadataSuffix(withoutMetaSuffix);
}

function stripMetadataSuffix(value: string): string {
  const extension = path.posix.extname(value);
  return extension.length > 0 ? value.slice(0, -extension.length) : value;
}
