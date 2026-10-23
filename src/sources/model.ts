/** Immutable source identity. Contains no credential or physical storage path. */
export interface SourceDescriptor {
  id: string;
  kind: 'org' | 'local';
  location?: 'org' | 'server' | 'upload' | 'git';
  label: string;
  detail?: string;
  username?: string;
  maskedOrgId?: string;
  orgIdentityFingerprint?: string;
  environment?: 'production' | 'sandbox' | 'unknown';
  expiresAt?: string;
  provenance?: {
    provider: 'github' | 'gitlab' | 'bitbucket'; host: string; repositoryId: string; repositoryPath: string;
    refType: 'branch' | 'tag' | 'commit'; refName: string; commitSha: string; projectRoot: string;
    metadataType?: string; importedAt: string; importedContentChecksum: string; sourceOwnerUserId: string; importId: string;
  };
}

export interface SourceProject { id: string; displayName: string; manifests: string[] }


export type SourceSpec = OrgSourceSpec | LocalSourceSpec;

export interface OrgSourceSpec {
  kind: 'org';
  alias: string;
  displayName: string;
}

export interface LocalSourceSpec {
  kind: 'local';
  projectPath: string;
  displayName: string;
}

export interface MetadataTypeDescriptor {
  directoryName: string;
  xmlName: string;
  suffix?: string;
}

export interface MetadataSnapshot {
  provenance?: NonNullable<SourceDescriptor['provenance']>;
  source: SourceSpec;
  packageRoot: string;
  manifestPath: string;
  manifestSha256: string;
  payloadSha256: string;
  payloadDigestVersion?: 2;
  createdAt: string;
  metadataTypes?: MetadataTypeDescriptor[];
}
