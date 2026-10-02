# 셀프호스팅 Git URL 후속 수정 완료

작성일: 2026-09-22. 상태: `IMPLEMENTED_LOCAL`.

## 완료한 구현

- GitHub Enterprise / GitLab Self-managed / Bitbucket Data Center의 전체 HTTPS URL을 저장·후속 요청·provenance에 보존한다.
- UI 저장소 확인 뒤 refs 조회·가져오기·브랜치 등록에 `cloneUrl`을 사용한다. 서버는 공식 호스트의 기존 짧은 경로 형식을 유지하고 셀프호스트만 전체 URL을 저장한다.
- 사용자 지정 HTTPS 포트와 context path, Bitbucket의 `/scm/TEAM/repo.git`·`/scm/~user/repo.git` 형태를 허용한다.
- HTTPS, URL 내 인증정보·query/fragment·경로 순회 차단, 사설 IP 명시 허용, DNS pinning 및 TLS 검증을 유지한다. 공식 호스트의 잘못된 포트/제공자 조합도 계속 거절한다.
- Git credential bridge는 호스트뿐 아니라 포트·전체 저장소 경로를 확인한다. refs/최초 fetch/fetch-lazy 모두 실제 포트로 DNS pinning한다.
- 저장소 ID에 포트를 포함해 같은 도메인의 다른 포트 저장소를 구분한다. 토큰 교체·연결 확인도 전체 clone URL 일치를 요구한다.
- 셀프호스팅은 저장소 단위 연결로 Git 프로토콜을 사용하며 클라우드 REST API로 재해석하지 않는다. 서비스와 제공자 adapter 양쪽에서 차단한다.

## 기존 기록 복구

DB migration 39가 하나의 트랜잭션에서 수행된다. 토큰 복호화나 네트워크 연결은 하지 않는다.

- 이미 전체 URL이 있으면 검증·정규화한다.
- 짧은 경로는 같은 소유자·provider·저장소 경로가 일치하는 연결 또는 저장된 provenance로 원래 호스트를 확정할 수 있을 때만 복구한다.
- 근거가 없으면 `GIT_REPOSITORY_URL_REQUIRED`로 표시하고 등록 브랜치 자동 동기화·비교 준비를 차단한다. UI 다시 가져오기는 URL 입력란을 비워 전체 URL 입력을 요구한다.
- 기존 별칭·암호화된 토큰·배포 payload는 변경하지 않는다. 이관을 재실행해도 같은 결과를 유지한다.

## 검증 결과

- `npm run check`: 타입·품질 검사, 72개 테스트 파일 / 471개 테스트, CLI/UI 빌드 PASS.
- `npm run lockfile:check`, `git diff --check`: PASS.
- Git UI Playwright: 39/39 PASS. 세 제공자의 도메인·포트·context 경로 보존과 레거시 URL 재입력 포함.
- 실제 Git HTTPS fixture: 2/2 PASS. 임시 TLS 인증서를 신뢰 CA로 지정하고 검증을 켠 채 loopback에서 테스트했다. 도메인 DNS만 fixture IP로 대체했으며 실제 Git 출력은 mock하지 않았다.
- HTTPS fixture 범위: credential challenge, ls-remote, 고정 commit/branch, partial clone, 여러 누락 blob 수신·복원, 캐시 재사용, 잘못된 객체 요청 후 정상 재시도, promisor 임시 설정 정리.
- 이관 fixture: 세 제공자 복구, 다른 소유자/경로/provider 및 근거 없는 기록 차단, 별칭/토큰 보존, 재실행 멱등성.

이는 Linux 로컬 검증이며 Windows 실기기·사용자 사설 GitLab·실제 Salesforce 배포 증거가 아니다.
OpenSSL이 PATH에 없는 환경에서는 HTTPS fixture가 skip되므로 이를 통과로 계산하면 안 된다.
사용자가 지정한 사설 GitLab에는 접속하지 않았으며 커밋·push·압축·업로드도 수행하지 않았다.

남은 외부 검증은 [working 검증 목록](../../working/sfud-git-environment-verification-20260922.md)에만 유지한다.
