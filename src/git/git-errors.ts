export type GitErrorCode =
  | 'INVALID_REPOSITORY' | 'REPOSITORY_UNAVAILABLE' | 'REPOSITORY_PERMISSION_DENIED'
  | 'PROVIDER_NOT_CONFIGURED' | 'GIT_CONNECTION_REQUIRED' | 'GIT_REAUTH_REQUIRED'
  | 'GITHUB_ACCOUNT_PERMISSION_DENIED' | 'GITLAB_ACCOUNT_PERMISSION_DENIED' | 'BITBUCKET_ACCOUNT_PERMISSION_DENIED' | 'GIT_ACCOUNT_UNAVAILABLE'
  | 'REF_CHANGED' | 'INVALID_REF' | 'PROVIDER_RATE_LIMITED' | 'UNSUPPORTED_METADATA_TYPE'
  | 'DX_PROJECT_NOT_FOUND' | 'PROJECT_SELECTION_REQUIRED' | 'UNSAFE_PROJECT_PATH'
  | 'UNSUPPORTED_SOURCE_FEATURE' | 'GIT_QUOTA_EXCEEDED' | 'IMPORT_EXPIRED'
  | 'IMPORT_CANCELLED' | 'IMPORT_TIMEOUT' | 'GIT_PROCESS_FAILED' | 'GIT_REMOTE_UNAVAILABLE' | 'INVALID_GIT_OBJECT';

const messages: Record<GitErrorCode, string> = {
  INVALID_REPOSITORY: '지원하는 제공자의 올바른 HTTPS 저장소 주소가 필요합니다.',
  REPOSITORY_UNAVAILABLE: '저장소가 없거나 접근 권한이 필요합니다.',
  REPOSITORY_PERMISSION_DENIED: '이 저장소에 접근할 권한이 없습니다.',
  PROVIDER_NOT_CONFIGURED: 'Git 가져오기가 비활성화되었거나 토큰 저장 키 설정이 필요합니다.',
  GIT_CONNECTION_REQUIRED: '저장소에 접근하려면 Git 계정을 연결하세요.',
  GIT_REAUTH_REQUIRED: '토큰이 만료되었거나 유효하지 않습니다. 권한과 만료일을 확인하고 토큰을 교체하세요.',
  GITHUB_ACCOUNT_PERMISSION_DENIED: 'GitHub 계정 조회가 거부되었습니다. PAT 종류와 조직의 토큰 승인·접근 정책을 확인하세요. 아직 저장소 접근을 검사한 단계가 아닙니다.',
  GITLAB_ACCOUNT_PERMISSION_DENIED: 'GitLab 계정 조회가 거부되었습니다. Code Download 또는 read_repository 전용 토큰은 저장소 URL을 입력하는 저장소 단위 연결을 사용하세요. 계정 목록 연결에는 별도 API 읽기 권한이 필요합니다.',
  BITBUCKET_ACCOUNT_PERMISSION_DENIED: 'Bitbucket 계정 조회가 거부되었습니다. 저장소 읽기 전용 API Token은 저장소 단위 연결을 사용하세요. 계정 목록 연결에는 read:user:bitbucket이 추가로 필요합니다.',
  GIT_ACCOUNT_UNAVAILABLE: 'Git 제공자의 계정 정보를 확인하지 못했습니다. 제공자 상태와 계정 접근 정책을 확인하고 다시 시도하세요.',
  REF_CHANGED: '선택한 ref의 커밋이 변경되었습니다. 기준 커밋을 다시 확인하세요.',
  INVALID_REF: '올바른 branch, tag 또는 전체 커밋 SHA가 필요합니다.',
  UNSUPPORTED_METADATA_TYPE: '목록에서 지원하는 Git 메타데이터 타입을 선택하세요.',
  PROVIDER_RATE_LIMITED: 'Git 제공자의 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
  DX_PROJECT_NOT_FOUND: '저장소에서 Salesforce DX 프로젝트를 찾지 못했습니다.',
  PROJECT_SELECTION_REQUIRED: '가져올 Salesforce DX 프로젝트 루트를 선택하세요.',
  UNSAFE_PROJECT_PATH: '프로젝트에 허용되지 않는 경로나 충돌하는 파일이 있습니다.',
  UNSUPPORTED_SOURCE_FEATURE: '선택한 프로젝트의 symlink, submodule 또는 Git LFS 소스는 지원하지 않습니다.',
  GIT_QUOTA_EXCEEDED: 'Git 가져오기 용량 또는 파일 개수 제한을 초과했습니다.',
  IMPORT_EXPIRED: '가져온 소스가 만료되었습니다. 다시 가져오세요.',
  IMPORT_CANCELLED: 'Git 가져오기가 취소되었습니다.',
  IMPORT_TIMEOUT: 'Git 가져오기 제한 시간을 초과했습니다.',
  GIT_PROCESS_FAILED: 'Git 작업을 완료하지 못했습니다.',
  GIT_REMOTE_UNAVAILABLE: 'Git 저장소 접근을 확인하지 못했습니다. 저장소 URL, 토큰의 코드 읽기 권한, 서버의 Git 설치와 네트워크를 확인하세요.',
  INVALID_GIT_OBJECT: 'Git 커밋 또는 파일 데이터를 확인할 수 없습니다.',
};

// Never include provider bodies, Git stderr, URLs with credentials or local paths.
export class GitError extends Error {
  public retryAfterSeconds?: number;
  public constructor(public readonly code: GitErrorCode) {
    super(messages[code]);
    this.name = 'GitError';
  }
}
