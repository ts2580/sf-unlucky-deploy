export interface XmlCollectionPolicy {
  identityKeys: readonly string[];
  ordered: boolean;
}

interface MetadataXmlPolicy {
  collections: Readonly<Record<string, XmlCollectionPolicy>>;
}

const PROFILE_COLLECTIONS: Readonly<Record<string, XmlCollectionPolicy>> = {
  'Profile.applicationVisibilities': unordered('application'),
  'Profile.classAccesses': unordered('apexClass'),
  'Profile.customPermissions': unordered('name'),
  'Profile.fieldPermissions': unordered('field'),
  'Profile.flowAccesses': unordered('flow'),
  'Profile.layoutAssignments': unordered('layout', 'recordType'),
  'Profile.objectPermissions': unordered('object'),
  'Profile.recordTypeVisibilities': unordered('recordType'),
  'Profile.tabVisibilities': unordered('tab'),
  'Profile.userPermissions': unordered('name'),
};

const PERMISSION_SET_COLLECTIONS: Readonly<Record<string, XmlCollectionPolicy>> = {
  'PermissionSet.applicationVisibilities': unordered('application'),
  'PermissionSet.classAccesses': unordered('apexClass'),
  'PermissionSet.customPermissions': unordered('name'),
  'PermissionSet.fieldPermissions': unordered('field'),
  'PermissionSet.flowAccesses': unordered('flow'),
  'PermissionSet.objectPermissions': unordered('object'),
  'PermissionSet.recordTypeVisibilities': unordered('recordType'),
  'PermissionSet.tabSettings': unordered('tab'),
  'PermissionSet.userPermissions': unordered('name'),
};

const LAYOUT_COLLECTIONS: Readonly<Record<string, XmlCollectionPolicy>> = {
  'Layout.layoutSections': ordered('label'),
  'Layout.layoutSections.layoutColumns': ordered(),
  'Layout.layoutSections.layoutColumns.layoutItems': ordered('field'),
  'Layout.platformActionList.platformActionListItems': ordered('actionName'),
  'Layout.relatedLists': ordered('relatedList'),
};

const XML_SEMANTIC_POLICIES: Readonly<Record<string, MetadataXmlPolicy>> = {
  Profile: { collections: PROFILE_COLLECTIONS },
  PermissionSet: { collections: PERMISSION_SET_COLLECTIONS },
  Layout: { collections: LAYOUT_COLLECTIONS },
};

export function hasXmlSemanticPolicy(metadataType: string | undefined): boolean {
  return metadataType !== undefined && XML_SEMANTIC_POLICIES[metadataType] !== undefined;
}

export function findXmlCollectionPolicy(
  metadataType: string | undefined,
  xmlPath: string,
): XmlCollectionPolicy | undefined {
  if (metadataType === undefined) return undefined;
  return XML_SEMANTIC_POLICIES[metadataType]?.collections[normalizeXmlPath(xmlPath)];
}

function normalizeXmlPath(xmlPath: string): string {
  return xmlPath.replace(/\[[^\]]*\]/gu, '');
}

function unordered(...identityKeys: string[]): XmlCollectionPolicy {
  return { identityKeys, ordered: false };
}

function ordered(...identityKeys: string[]): XmlCollectionPolicy {
  return { identityKeys, ordered: true };
}
