import type { WorkspaceSource } from '../api/workspace-contracts.js';

export function assertGitMetadataScope(source: WorkspaceSource, requestedTypes: readonly string[] | undefined): void {
  const scope = source.provenance?.metadataType;
  if (scope !== undefined && (requestedTypes === undefined || requestedTypes.length === 0
    || requestedTypes.some((type) => type !== scope))) {
    throw new Error(`이 Git 소스에는 ${scope}만 준비되어 있습니다. 사용할 메타데이터 타입으로 다시 가져오세요.`);
  }
}
