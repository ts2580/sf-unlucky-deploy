# Git 가져오기 구현·검증 기록 보관본

2026-09-22 작업 목록 정리 시점의 기록이다. 아래 체크박스는 당시 이력이며 현재 작업 목록이 아니다.
현재 남은 작업은 [working 실환경 검증 목록](../../working/sfud-git-environment-verification-20260922.md)을 기준으로 한다.
당시 미구현이던 G01은 이후 [셀프호스트 URL 수정 완료 기록](./sfud-selfhost-url-completed-20260922.md)에서 완료했다.
G02–G07의 로컬 구현·검증 기록을 보존하며 원격 검증이나 운영 배포 완료를 뜻하지 않는다.

작성일: 2026-09-22
상태: `IN_PROGRESS` — G01 수정 대기. G02–G07 로컬 구현·검증. G02는 사용자도 수신 성공을 보고함.

## G01. 셀프 호스트 저장소 URL 보존

상태: 코드에서 결함 확인, 수정 대기.

- 입력 예: `https://gitlab.hmc.co.kr/ict-mks/connex-hmc.git` (접속하지 않음).
- `src/git/git-import-service.ts:126`은 가져오기 레코드에 `address.repositoryPath`만 저장한다.
- `src/git/git-registration-service.ts:43`도 등록 브랜치의 `request_json`에 경로만 저장한다.
- 이때 `ict-mks/connex-hmc`만 남아 호스트가 유실된다. 이를 `normalizeRepository(..., 'gitlab')`로 다시 해석하면 기본 호스트 `gitlab.com`이 붙는다.
- 최초 가져오기의 비동기 `fetch()`도 저장 레코드를 `authorize()`에 전달하므로 재실행 전부터 영향을 받는다. 등록 직후 sync, 재동기화, 비교 준비에도 영향을 준다.
- 셀프 호스트 연결을 사용하면 `GitRepositoryAccess.validate()`의 호스트 일치 검사에서 `GIT_CONNECTION_REQUIRED`로 차단된다. 이 경로에서 해당 연결의 토큰을 다른 호스트에 전달하지 않는다.

작업:

- [ ] 두 저장 지점에 기존 `connectionRepositoryPath(address)` 또는 같은 의미의 공통 직렬화 함수를 적용해 셀프 호스트의 정규화된 전체 HTTPS URL을 보존한다.
- [ ] 연결 등록·카탈로그·가져오기·브랜치 등록·재동기화·비교 준비를 오가는 주소 직렬화 경로를 점검한다.
- [ ] 이미 경로만 저장된 레코드의 복구 정책을 정한다. 같은 소유자의 연결 ID, provider, 저장소 경로 등으로 원래 호스트를 확정할 수 있는 경우에만 복구하고, 불명확한 데이터는 재등록을 요구한다.
- [ ] 셀프 호스트의 최초 가져오기, 저장 후 재조회, 서비스 재생성 후 등록 브랜치 동기화/비교 준비에 대한 회귀 테스트를 추가한다.
- [ ] 공식 호스트의 기존 경로 형식 호환성과 호스트가 다른 연결의 거부 동작을 검증한다.

## G02. Partial clone 누락 blob hydration 실패 조사

상태: `IMPLEMENTED_LOCAL`. 사용자 요청에 따라 공식 promisor fetch의 누락 설정을 보강. 사용자가 변경 후 수신 성공을 보고했다. 에이전트의 Windows/해당 GitLab 재검증은 없으며, 두 설정 중 어느 하나가 원인이었는지는 원본 stderr 없이는 분리 확정하지 않는다.

확인된 흐름:

1. `src/git/git-object-store.ts`의 `prepareBlobs()`가 `cat-file --batch-check`의 `<SHA> missing` 결과를 모은다.
2. 중복 제거·SHA 형식 검증 후 누락 SHA를 최대 500개씩 전달한다.
3. `src/git/git-client.ts`의 hydration 콜백이 아래 명령의 표준 입력에 SHA를 줄바꿈으로 구분해 넣는다.

```text
git fetch --filter=blob:none --no-tags --no-recurse-submodules --no-write-fetch-head --stdin -- <cloneUrl>
```

원인 설명 시 주의:

- `--stdin`이 refspec을 읽는 것은 맞지만, 완전한 객체 SHA도 refspec의 source로 허용된다. 따라서 “blob SHA를 stdin에 넣었으므로 잘못된 refspec”이라고 확정하면 안 된다.
- Git 2.43.0 자체의 `promisor-remote.c`도 객체 SHA 목록을 `fetch --filter=blob:none --stdin`에 전달한다. 자체 lazy fetch에는 `fetch.negotiationAlgorithm=noop`이 추가되며, 앱은 partial fetch 후 promisor remote 설정을 제거한다. 두 차이와 서버의 객체 요청 지원 여부를 조사하되, 아직 원인으로 단정하지 않는다.
- 기존 hydration 테스트는 `runIsolatedGit`을 mock 처리해 SHA 전달·배치·정리만 확인했다. 후속 구현에서 실제 Git 프로세스 기반 통합 테스트를 추가했다.

2026-09-22 로컬 진단:

- Linux Git 2.43.0, 임시 bare 원본 저장소에 blob/tree/commit 생성.
- 로컬 `file://` 전송의 원본에 filter 및 객체 SHA 요청 허용. 최초 `--depth=1 --filter=blob:none` fetch 후 앱처럼 promisor remote 설정 제거.
- `cat-file --batch-check`에서 blob이 실제 `missing`인 것을 확인.
- 앱과 같은 hydration 명령에 blob SHA를 전달한 결과 종료 코드 0, 해당 객체가 `blob`으로 확인됨.
- 별도 저장소에서 `fetch.negotiationAlgorithm=noop`을 추가한 경우도 성공.
- 진단 fixture: `/tmp/sfud-blob-diagnosis-3cBJ2O` (임시 경로).
- 이 결과는 해당 최소 조건에서 SHA 입력이 유효하다는 증거다. Windows Git, HTTPS 전송, 사용자의 GitLab 및 기존 캐시 상태에서 성공했다는 뜻은 아니다.

작업:

- [ ] 실제 실패 환경의 Git 버전, 실패 subprocess, 토큰·민감 URL을 제거한 `bad revision` 주변 stderr와 요청 SHA의 객체 종류를 확보한다.
- [ ] 새 캐시/기존 캐시, branch ref 유무, shallow 상태, 다중 blob 및 재시도 조건을 포함한 실제 Git 재현을 만든다.
- [ ] HTTPS 전송과 Windows/Linux 차이, promisor 설정 제거 및 negotiation 옵션의 영향을 비교한다.
- [x] 사용자 요청에 따라 hydration에 `fetch.negotiationAlgorithm=noop` 적용. 명령 범위 `remote.<cloneUrl>.promisor=true`와 `partialclonefilter=blob:none`을 함께 전달해 promisor 문맥 보존. SHA의 stdin 전달은 유지.
- [x] 위 임시 설정은 명령 종료와 함께 사라지므로 hydration 뒤 영구 설정 삭제 호출 제거.
- [x] `test/git-partial-fetch.test.ts` 추가: 실제 Git 프로세스에 로컬 file 전송만 대체해 고정 commit/branch 두 경로에서 누락 확인 → 선택 blob 수신 → 파일 복원 → 캐시 재사용 → 미선택 blob 추가 수신을 검증.
- [x] 정상/실패한 blob 수신 후 로컬 config에 promisor/filter/negotiation 설정이 남지 않는지 검증.
- [x] 기존 전송 테스트에서 DNS pinning, credential bridge, 취소·용량 제한 전달 및 실패 시 bridge 정리 검증 유지.

## G03. Git 실패 진단 로그

상태: `IMPLEMENTED_LOCAL`.

- [x] 데이터 디렉터리의 `logs/git-diagnostics.jsonl` 및 실행 터미널에 실패 시각·operationId·단계·종료 코드·소요 시간·마스킹된 stderr 기록.
- [x] 가져오기 ID/등록 브랜치 ID를 비동기 실행 문맥에 전달. fetch-lazy에는 요청 객체 개수, 프로세스 시작 실패에는 ENOENT 등 코드 기록.
- [x] 실제 credential, 인코딩된 credential, nonce, 인증 헤더, URL 마스킹. API 오류에는 원문 stderr를 반환하지 않음.
- [x] stderr 수집 크기 제한, 1 MiB 로그 순환과 이전 파일 한 개 보관. 파일 기록 실패 시 원래 작업 오류 유지.
- [x] 실제 Git 오류, 마스킹, 병렬 작업 ID 격리, 파일 기록 실패, 순환, ENOENT 검증 7개 통과.

## G04. 브랜치 목록 로딩 표시

상태: `IMPLEMENTED_LOCAL`.

- [x] 설정의 브랜치/태그 목록 요청과 추가 페이지 조회 중 로딩 문구 표시, finally에서 해제.
- [x] 비교 소스/타겟의 브랜치 조회 안내 문구 통일 및 aria-busy 적용.
- [x] 지연된 브랜치 응답과 태그 오류 응답에서 문구 표시·해제 및 입력 잠금 검증. 비교 소스 로딩 포함 Playwright 2개 통과.
- [x] E2E fixture의 신규 관리자 IP 목록 API mock 누락으로 발생하던 401/로그아웃을 보완.

참고:

- [Git fetch 공식 문서: refspec과 --stdin](https://git-scm.com/docs/git-fetch)
- [Git 2.43.0 promisor-remote.c](https://github.com/git/git/blob/v2.43.0/promisor-remote.c)

## 완료 기준

- [ ] G01 저장/재실행 회귀 테스트 및 G02 실제 누락 blob 수신·복원 테스트 통과.
- [x] 관련 타입 검사 및 기존 Git 테스트 통과. `npm run check`: 타입/품질 검사, 70개 파일·447개 테스트, CLI/UI 빌드 통과.
- [x] 로컬 검증과 Windows/실제 GitLab 검증 결과 구분: Linux Git 및 Git UI Playwright 35개 통과. Windows 실행과 사용자 GitLab 접속/재현은 수행하지 않음.
- [ ] 배포용 빌드·압축·업로드 여부를 별도 기록. 이 작업 목록 작성 시점에는 새 패키징·업로드를 수행하지 않음.

최종 CLI/UI 빌드는 로컬 `dist/`에 반영했다. 새 압축파일 생성과 Synology 업로드는 수행하지 않았다.

## G05. 저장한 Git 연결·브랜치 별칭

상태: `IMPLEMENTED_LOCAL`.

- [x] migration 38: 연결/등록 브랜치에 nullable alias 추가.
- [x] 소유자·역할·CSRF 검증을 거친 별칭 변경 API. 최대 80자, 빈 값은 해제.
- [x] 설정 편집, 소스/타겟 및 연결 선택 UI에 별칭 표시. 원본 URL은 상세 정보에 유지.
- [x] URL·암호화된 토큰·토큰 버전 불변, 토큰 교체/동기화 후 별칭 유지 API 테스트.
- [x] 브라우저 저장/새로고침/해제/모바일/소스 선택 검증.

## G06. 비교 결과 상태 필터·검색

상태: `IMPLEMENTED_LOCAL`.

- [x] NEW / TARGET ONLY / MODIFIED / IDENTICAL 클릭 시 해당 상태만 표시.
- [x] 이름·타입·파일 경로 부분 검색, 대소문자 무시, 상태 필터와 AND 적용.
- [x] 필터 변경 시 페이지 초기화, 결과 수/빈 결과 표시, 배포 선택 유지.
- [x] 숨겨진 IDENTICAL은 권한 확인 후 저장된 결과에서 조회. 새 원격 호출 없음.
- [x] API 기본 숨김 유지/명시 조회/비로그인 차단/추가 SF 호출 없음 테스트 및 브라우저 결합 필터 검증.

## G07. 하위 폴더 Apex 평탄화

상태: `IMPLEMENTED_LOCAL`.

- [x] Git 작업 복사본의 classes 하위 `.cls`/`.cls-meta.xml`을 해당 classes 바로 아래로 복원.
- [x] 원본 객체·커밋은 보존, 복원 blob 검증 및 실제 평탄 경로 기준 checksum 생성.
- [x] monorepo·여러 package·선택 타입 가져오기·restoreFiles/직접 blob 양쪽 경로 테스트.
- [x] 폴더/package 간 클래스명 충돌, 대소문자 충돌 및 다른 폴더의 companion 결합을 거절.
- [x] `.forceignore` 제외 경로를 펼쳐서 재포함하지 않음. LWC/보고서 등 다른 구조 유지.
- [x] 실제 로컬 SF CLI로 manifest 생성/MDAPI 변환, 평탄한 클래스명·companion 및 ignored 클래스 제외 확인.
- [x] 재실행용 로컬 증거 스크립트: [verify-foldered-apex-20260922.ts](./verify-foldered-apex-20260922.ts). 프로젝트 루트에서 `node --import tsx docs/archive/verify-foldered-apex-20260922.ts`로 실행. 원격 접속/실제 배포 없음.
- [ ] Windows 실기기 및 실제 사용자 저장소로 재검증. 기존 가져온 소스는 재가져오기/동기화 필요.
