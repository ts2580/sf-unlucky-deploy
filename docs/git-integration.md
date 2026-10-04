# Git 연결과 프로젝트 가져오기

[README로 돌아가기](../README.md)

## Git 프로젝트 가져오기

Git DX 프로젝트의 `classes/interface/Foo.cls` 같은 하위 폴더 Apex는 작업용 복사본에서
`classes/Foo.cls`로 펼친 뒤 비교·배포에 사용한다. `.cls-meta.xml`도 함께 펼치며 원본 Git 경로와
파일 내용은 변경하지 않는다. 여러 package/폴더의 같은 클래스명(대소문자 차이 포함)은
덮어쓰지 않고 `APEX_PATH_COLLISION`으로 거절한다. `.forceignore`로 제외한 경로는 펼치지 않으며,
LWC 번들·보고서 폴더 등 다른 메타데이터의 구조는 유지한다. 기존 가져오기에는 재가져오기/동기화가 필요하다.

비교 결과의 NEW / TARGET ONLY / MODIFIED / IDENTICAL 버튼은 해당 상태만 표시한다.
메타데이터 검색은 이름·타입·파일 경로를 대소문자 구분 없이 찾으며 상태 필터와 함께 적용된다.
필터 변경 시 첫 페이지로 이동하지만 배포 선택은 유지한다. IDENTICAL은 필요할 때 저장된 비교 결과에서
불러오며 Git/Salesforce를 다시 조회하지 않는다. 상태는 여러 개를 함께 선택할 수 있고, 다시 누르면 해제된다. 모든 상태를 해제하면 전체 목록을 표시하며 검색어는 검색창에서 지운다.

설정의 저장된 Git 연결과 등록 배포 브랜치에서 **별칭 설정/변경**으로 80자 이내의 짧은 이름을 붙일 수 있다.
별칭은 소스·타겟 선택 목록에도 표시되며 실제 URL·인증 정보·저장소 식별자는 바뀌지 않는다.
빈 값으로 저장하면 기본 이름으로 돌아간다. 별칭 변경에는 토큰 재입력이 필요 없으며 토큰 교체 후에도 유지된다.

Git 작업 실패 시 실행 터미널과 데이터 디렉터리의 `logs/git-diagnostics.jsonl`에 진단 로그를 남긴다.
기본 경로는 `.sfud/logs/git-diagnostics.jsonl`이며 `--data-dir` 또는 `SFUD_DATA_DIR` 지정 시 해당 디렉터리를 사용한다.
로그에는 시각, `operationId`(가져오기/등록 브랜치 ID 또는 연결 확인 요청 ID), 실패 단계,
Git 종료 코드·실행 오류 코드·소요 시간과 마스킹된 stderr가 들어간다. 누락 blob 수신 단계는
`fetch-lazy`로 표시하며 요청 blob 개수도 기록한다. 토큰·인증 헤더·URL은 가리고,
stdout·명령 전체·환경변수는 기록하지 않는다. UI/API에는 기존의 안전한 오류 메시지만 반환한다.
파일은 1 MiB 단위로 순환하며 이전 로그 한 개(`git-diagnostics.jsonl.1`)를 보관한다.
변경 적용 후 재현한 실패부터 기록되며 이전에 버린 stderr는 복구할 수 없다.

PowerShell에서 실시간 확인:

```powershell
Get-Content .\.sfud\logs\git-diagnostics.jsonl -Tail 30 -Wait
```

로그 파일은 첫 실패 시 생성된다. 사용자 지정 데이터 경로라면 위 경로도 변경한다.

### 등록 배포 브랜치와 자동 동기화

설정에서 저장소를 확인하고 브랜치 및 DX 프로젝트 경로(루트는 `.`)를 지정한 뒤
**배포 브랜치 등록**을 누른다. 최초 준비는 커밋·트리와 프로젝트 설정을 확인하며
모든 메타데이터를 checkout하지 않는다. 등록 정보와 마지막 성공 SHA는 SQLite에 저장한다.

비교 화면에서 등록 브랜치와 메타데이터 타입을 선택하면 자동 fetch 후 확정한 SHA의
필요 파일만 `git restore`로 준비한다. 설정의 **지금 동기화**는 수동 갱신 기능이다.
fetch 실패 시 과거 소스로 자동 대체하지 않는다. 비교 후 브랜치가 변경되어도 이미 만든
비교 snapshot과 승인된 배포 payload는 변경하지 않는다.

캐시는 DB 디렉터리의 `git-cache/`에 보관하며 사용자·Git 연결·저장소 식별자로 격리한다.
동일 캐시의 fetch·객체 확보·restore 준비는 직렬화하고, 준비가 끝난 비교는 최대 2개를 병렬 실행한다.
실제 배포 큐는 기존처럼 한 번에 하나만 실행한다. 복원 파일과 별도 Git index는
내부 세션 작업공간 ID·비교 작업 ID·소스 위치(left/right)별로 격리한다. 쿠키 원문은 경로에 사용하지 않는다.

캐시별 한도는 100 MiB, 전체 캐시 한도는 2 GiB다. 공간 예약이 부족하면 미사용 캐시를
오래된 순서로 회수하며 사용 중인 캐시는 제거하지 않는다. 캐시가 회수되어도 등록은 유지되고
다음 요청에서 다시 준비한다. 같은 데이터 디렉터리는 한 서버만 사용하도록 OS 파일 잠금으로 보호한다.
`:memory:` 테스트 런타임은 독립 임시 캐시를 사용한다.

누락 blob 수신은 Git의 promisor fetch 방식에 맞춰 `fetch.negotiationAlgorithm=noop`을 사용한다.
해당 fetch 명령에만 promisor/filter 설정을 전달하고 SHA 목록을 `--stdin`으로 요청한다.
설정을 로컬 저장소에 남기지 않아 이후 객체 읽기는 자동 원격 수신을 수행하지 않는다.

서버 재시작 후 등록과 캐시는 유지된다. 중단된 동기화는 실패로 표시하며 다음 요청에서 재시도한다.
임시 READY 소스는 기존처럼 만료시키지만 완료 비교·배포 payload는 기존 run-storage 정책으로 보존한다.
등록 해제는 기존 비교 이력이나 배포 자료를 삭제하지 않는다. 다중 서버가 하나의 캐시 볼륨을 공유하는 구성은 지원하지 않는다.

등록 API는 `GET/POST /api/v1/git/registrations`,
`POST /api/v1/git/registrations/:id/sync`, `DELETE /api/v1/git/registrations/:id`다.
등록 요청은 기존 import 요청의 branch ref와 projectRoot를 사용하며, 타입은 비교 요청에서 정한다.
워크스페이스의 `git-registered:<id>`를 비교 소스로 전달하면 서버가 최신화와 작업별 소스 준비를 수행한다.

### 일회성 커밋 가져오기

설정 화면에서 GitHub.com / GitLab.com / Bitbucket Cloud 계정을 연결하고 저장소·브랜치·태그·전체 커밋 SHA를 선택한다.
공식 클라우드의 공개 저장소는 계정 연결 없이 URL로 가져올 수 있다. 셀프호스팅은 **저장소 하나 연결**을 사용한다.
여러 DX 프로젝트가 있는 저장소는 가져오기 목록에서 루트를 선택한다.
비교 및 배포에서는 등록된 저장소 → 브랜치 검색·선택 → 가져올 메타데이터 타입 → 소스 준비 순으로 진행한다.
타겟에도 Git 저장소를 선택할 수 있으며 소스·타겟의 브랜치를 각각 준비해 org↔Git 또는 Git↔Git을 비교한다.
양쪽 Git에서 가져온 메타데이터 타입은 같아야 한다. Git 타겟은 비교 전용으로 배포 항목 선택·Dry-run·실제 배포를 지원하지 않는다.
Git을 소스로 쓰고 Salesforce org를 타겟으로 선택하면 기존 배포 기능을 사용할 수 있다.
설정 화면의 가져오기에도 같은 타입 선택을 제공한다. 저장소 선택 항목은 브랜치나 타입을 바꿔도 늘어나지 않는다.
타입을 바꾸면 기존 소스·비교 결과·배포 선택을 초기화하고 새로 가져온다.
연결·저장소·가져오기 목록은 로그인 사용자별로 제공한다.

저장소 하나 연결에는 GitHub Enterprise Server, GitLab Self-managed, Bitbucket Data Center 같은
셀프호스팅 FQDN의 전체 HTTPS clone URL도 쓸 수 있다. 사용자 지정 HTTPS 포트와 context path를 지원한다.
예: `https://git.example.com:8443/gitlab/group/sub/repo.git`, `https://bitbucket.example.com:7990/bitbucket/scm/TEAM/repo.git`.
전체 URL은 refs 조회·가져오기·브랜치 등록·재동기화·비교 준비에 그대로 보존되며, 인증은 같은 호스트·포트·저장소 경로에만 전달한다.
셀프호스팅을 공식 클라우드 REST API로 바꾸어 조회하지 않는다. HTTP/SSH, URL 안의 사용자명·비밀번호,
query/fragment, 경로 순회, 잘못된 포트는 계속 거절하고 TLS 인증서 검증도 유지한다.
DB migration 39는 과거 경로만 저장된 기록을 같은 소유자의 연결·provider·경로 또는 저장된 provenance로
확정할 수 있을 때만 복구한다. 확인할 수 없으면 자동 동기화/비교를 차단하고 전체 HTTPS URL 재등록을 안내한다.
이때 기존 별칭·토큰·고정 배포 payload는 변경하지 않는다.

기본적으로 DNS의 모든 응답은 공개 IP여야
한다. 사설망 Git 서버는 운영자가 `SFUD_GIT_ALLOWED_IPS`에 정확한 IPv4/IPv6 주소를 쉼표로 등록한
경우에만 사용한다. 관리자 UI의 **셀프호스팅 Git 허용 IP**에서도 등록·제거할 수 있으며 값은 SQLite에
저장되어 즉시 적용된다. 예를 들어 `.env`에 `SFUD_GIT_ALLOWED_IPS=192.168.10.25`를 넣고 서버를
재시작한다. CLI에서는 `--allow-git-ip 192.168.10.25`를 반복 지정할 수 있으며, CLI 값이 있으면
환경변수 대신 사용한다. UI 값은 환경변수/CLI 값에 추가되며 UI에서 제거해도 시작 설정은 유지된다.
CIDR·호스트명·URL의 직접 IP 입력은 허용하지 않는다. 등록한 FQDN의 DNS
응답 하나라도 공개 IP 또는 이 목록에 없으면 거절하고, 실제 Git 연결은 검증한 IP로 고정한다.
따라서 DNS 재바인딩으로 다른 내부 주소에 연결할 수 없다.

타입을 지정한 가져오기는 단일 커밋의 트리와 `sfdx-project.json`을 먼저 읽고, packageDirectories의
해당 타입 경로와 `.forceignore`만 추출한다. ApexClass의 본문/메타 파일, LWC·Aura의 전체 번들,
CustomField의 `objects/*/fields`와 부모 객체 설명 파일을 함께 보존한다. 여러 package directory와
모노레포의 DX 루트 선택을 지원한다. 같은 XML/폴더를 공유하는 타입(예: CustomLabel, WorkflowRule)은
필요한 상위 파일/폴더를 함께 가져오며, Salesforce CLI가 선택 타입으로 manifest를 제한한다.
CustomField·CustomLabel 같은 하위 타입은 비교할 때 개별 컴포넌트로 표시하며 원본 배포 XML과 checksum은 유지한다.
`.forceignore`는 CLI에서 적용하며, 무시된 파일도 선택 타입 폴더 안에 있으면 수신될 수 있다.

전송은 `--filter=blob:none`으로 시작하고 선택한 파일 객체만 인증·용량 제한 아래 묶어서 추가 수신한다.
제공자가 필터를 지원하지 않으면 Git이 전체 단일 커밋 파일을 전송할 수 있으나 작업공간 추출은
선택 타입으로 제한한다. 선택한 SHA와 타입은 SQLite 이력 및 작업 출처에 기록하고 다른 타입의
비교·배포 요청은 거절한다. Git 객체는 사용자·연결·저장소 단위의 영속 캐시에서 재사용하고, 복원한 소스는 작업별로 분리한다.

API에서는
`/api/v1/git/repositories/inspect`, `/refs`, `/api/v1/git/imports` API로 가져온다.
`provider`, `repositoryPath`, `ref: { kind, name }`, `expectedCommitSha`, `metadataType`을 지정하며
서버가 ref의 현재 SHA를 다시 확인한다. 여러 DX 프로젝트가 발견되면
`/api/v1/git/imports/:id/select-project`에 `projectRoot`를 보내 선택한다.
완료된 `git:<id>`는 workspace 소스와 manifest 프로젝트 목록에 포함된다.
비공개 요청에는 내 `connectionId`를 함께 보낸다. 기존 API 호환을 위해 `metadataType`을 생략한 요청은 전체 DX 프로젝트를 가져온다.

`GET /api/v1/git/connections/:id/repositories`는 저장소 선택기를 위한 페이지 API다.
Bitbucket은 먼저 워크스페이스 목록을 반환하며, 해당 ID를 `namespace`로 보내 저장소를 조회한다.
GitHub PAT는 토큰으로 조회 가능한 저장소 목록을 직접 반환한다.
GitLab은 subgroup을 포함한 내 프로젝트를 바로 반환한다. `cursor`는 응답의 `nextCursor`를 그대로 전달한다.
`search`는 GitLab/Bitbucket의 제공자 검색을 사용하고 GitHub에서는 각 결과 페이지를 필터링한다.
검색 결과가 없는 페이지에도 `nextCursor`가 있으면 다음 페이지를 조회할 수 있다.

가져온 파일은 사용자별 임시 디렉터리에 보관하고 사용자·서버 용량 한도를 적용한다.
수신 pack은 100 MiB, 추출 결과는 100 MiB/파일당 10 MiB로 제한한다. 파일 수로 가져오기나 배포를 차단하지 않는다.
설정 → 비교 및 배포 설정에서 사용자별 최대 비교 파일 수를 1~50,000개로 조절한다(기본 2,000개).
불러온 메타데이터의 상대 경로 합집합을 세며 보조 파일은 포함하고 프로젝트/manifest 설정은 제외한다.
상한과 같으면 비교하고, 초과하면 차이 계산 없이 Source 목록만 표시한다. Salesforce org에 대한 선택 배포·Dry-run은 계속 가능하다.
설정 변경은 메타데이터를 다시 불러올 때 적용하며, 비교를 생략한 사실과 당시 상한/파일 수는 결과·이력에 저장한다.
서버 동시 실행 2개, 처리 중 사용자별 3개/전체 20개, 가져오기·프로젝트 선택 제한 10분을 적용한다.
완료 소스의 기본 수명은 4시간이며 실행 중 작업에서 사용하는 소스는 삭제하지 않는다.
재시작하면 임시 소스는 만료된다. 저장소·ref·고정 SHA·프로젝트 루트·콘텐츠 checksum은
SQLite 이력과 비교/dry-run/snapshot에 남으며 승인 작업에도 복사한다.
재가져오기는 새 ID를 만들고 기존 준비된 배포 payload를 변경하지 않는다.

Git 인증의 초기 버전은 **사용자가 발급한 PAT/API Token**을 사용한다. OAuth App 등록,
callback, state, refresh 흐름은 포함하지 않는다. SFUD 로그인·역할은 그대로 유지한다.

설정 → **Git 계정 연결**에서 **저장소 하나 연결 (권장)**을 선택하고 제공자·저장소 Git URL·토큰을
입력한 뒤 **토큰 검증 후 등록**을 누른다. Git `ls-remote`로 해당 저장소의 접근과 ref를 확인하며
계정·워크스페이스 REST API를 호출하지 않는다. Bitbucket도 이 방식에서는 이메일이 필요 없다.
같은 토큰을 여러 저장소에서 쓰려면 저장소별로 등록한다. 연결은 등록한 정확한 저장소 경로로 제한된다.
등록 후 아래 가져오기 화면에 저장소 주소가 자동 입력된다.

브랜치·태그 조회와 SHA 고정도 Git으로 수행하므로 GitLab Fine-grained PAT의 Code Download,
Bitbucket의 저장소 읽기 범위만으로 이 경로를 사용할 수 있다. 계정 API를 사용할 수 있는 토큰은
**계정으로 저장소 목록 조회** 방식을 선택할 수 있으며, 이 경우 기존 제공자 API 기반 목록을 사용한다.
두 방식 모두 사용자 소유로 암호화 저장한다. 만료일은 선택 입력이며, 계정 API가 더 이른 만료일을
보고하면 그 값을 적용한다. Git 전용 연결에서는 만료일을 자동 조회하지 않는다.
Git 접근 확인은 해당 저장소를 읽을 수 있음을 뜻한다. 공개 저장소는 익명 접근도 가능하므로 이 결과를
토큰 소유 계정 인증이나 토큰 권한 전체의 검증으로 간주하지 않는다.

| 제공자 | 입력·권장 권한 | Git HTTPS 인증 | REST API 인증 |
|---|---|---|---|
| GitHub | Fine-grained PAT, 선택 저장소의 Contents: Read-only | x-access-token + PAT | Bearer PAT |
| GitLab | Fine-grained PAT의 Repository → Code → Download 또는 기존 PAT의 read_repository | oauth2 + PAT | 계정 목록 방식만 별도 API 읽기 권한 필요 |
| Bitbucket | API Token의 read:repository:bitbucket | x-bitbucket-api-token-auth + API Token | 계정 목록 방식만 이메일과 사용자·목록 API 읽기 권한 필요 |

권장 권한은 토큰의 실제 권한이 읽기 전용임을 보증하지 않는다. 앱은 저장소 조회·가져오기만 수행하며
토큰 발급 시 읽기 범위와 대상 저장소를 제한한다. 제공자 정책·조직 승인에 따라 저장소 접근이 거절될 수 있다.
공식 근거: [GitHub PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[GitLab 토큰 범위](https://docs.gitlab.com/security/tokens/access_token_scopes/),
[GitLab Fine-grained Git 권한](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_other/),
[Bitbucket API Token](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).

토큰 붙여넣기 시 앞뒤 공백은 제거한다. 내부 공백·줄바꿈은 값을 추측해 바꾸지 않고 입력 오류로 안내한다.
계정 목록 방식의 `/user` 403은 계정 조회 거절로 표시하며 저장소 접근 거절과 구분한다.
Bitbucket의 Repository/Project/Workspace Access Token은 API Token과 다른 인증 방식으로 이번 지원 범위에 포함하지 않는다.

기존 환경변수 토큰을 가져오려면 `SFUD_GITHUB_TOKEN`, `SFUD_GITLAB_TOKEN`,
`SFUD_BITBUCKET_TOKEN`을 지정한다. 저장소 단위 연결은 각각 `SFUD_GITHUB_REPOSITORY`,
`SFUD_GITLAB_REPOSITORY`, `SFUD_BITBUCKET_REPOSITORY`에 Git URL을 함께 지정한다.
REPOSITORY 설정이 없으면 계정 목록 방식이며 Bitbucket은 `SFUD_BITBUCKET_EMAIL`도 필요하다.
`SFUD_GIT_TOKEN_OWNER_EMAIL`에는 이 토큰을 소유할 기존 SFUD 사용자 이메일을 지정한다.
해당 사용자로 로그인한 뒤 **인증 관리 → Git → 환경변수 토큰 등록**을 누르면 UI와 같은 검증·저장 경로를 사용한다.
`POST /api/v1/git/connections/environment`도 동일하게 세션·CSRF·역할·소유 이메일을 확인한다.
서버 재시작이나 목록 조회만으로 등록·삭제한 토큰을 다시 덮어쓰지 않는다. 환경변수 값을 바꿨다면
프로세스를 재시작한 뒤 등록을 다시 실행한다. 다른 SFUD 사용자에게 환경변수 토큰을 공유하지 않는다.

`POST /api/v1/git/connections`의 입력은 `{ provider, token, repositoryPath?, apiUsername?, expiresAt? }`다.
`repositoryPath`를 지정하면 Git 전용 저장소 연결이며 생략하면 계정 API 연결이다.
계정 API 연결에서 Bitbucket의 `apiUsername`은 이메일이며 `expiresAt`은 선택적인 ISO 8601 시각이다.
`PUT /api/v1/git/connections/:id`는 기존과 동일한 연결 범위(저장소 또는 제공자 계정)의 토큰만 교체한다. 유효하지 않은 토큰으로
교체가 실패해도 기존 연결은 유지한다. 만료·철회된 토큰은 교체가 필요하며 자동 refresh하지 않는다.
연결 삭제는 로컬 암호문을 지우고 해당 연결의 대기·진행 가져오기를 취소한다. 토큰 자체의 원격
폐기는 제공자 계정 설정에서 수행한다. 이미 준비된 소스와 승인 payload는 기존 수명·권한을 유지한다.

PAT/API Token과 Bitbucket API 이메일은 내부 SQLite `git_connections`에 AES-256-GCM으로 암호화한다.
사용자·연결·제공자·호스트·용도를 인증 데이터에 결합한다. 토큰은 API 응답·브라우저 저장소·감사 기록·
Git URL·프로세스 인자·Git 설정 파일에 남기지 않는다. Git 자격 증명은 작업별 IPC helper로 전달한다.
Salesforce CLI 자식 프로세스에도 Git 토큰 환경변수를 전달하지 않는다.

Git과 Salesforce 인증 저장에 공통으로 사용할 암호화 키는 환경변수 또는 `~/.sfud/secrets.env`의 `SFUD_TOKEN_SECRET`에 32~1024자 문자열을 지정하면 된다.
`openssl rand -hex 32`로 생성한 임의 문자열을 권장하며, 앞뒤 공백과 줄바꿈·제어 문자는 허용하지 않는다.
예시의 설명 문구 대신 실제 생성한 값을 넣고 `start-local.sh`로 서버를 재시작한다.
직접 CLI를 실행할 때는 해당 환경변수를 프로세스에 전달해야 한다.

```dotenv
SFUD_TOKEN_SECRET="여기에 직접 생성한 32자 이상의 암호화 문자열 입력"
SFUD_GIT_TOKEN_KEY_VERSION=1
```

서버 시작 시 [Node.js scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)로
32바이트 AES 키를 도출한다(N=32768, r=8, p=1). migration 24의 `git_token_key_parameters`에는
DB별로 생성한 공개 salt만 저장하며, 암호화 문자열과 파생 키는 DB/API 응답에 저장하지 않는다.
같은 DB와 문자열이면 재시작 후에도 복호화할 수 있다. `.env`는 접근 권한을 제한하고 버전 관리에 넣지 않는다.

기존 `SFUD_GIT_TOKEN_KEY_FILE` 방식(32바이트 바이너리 파일, POSIX 0600)도 지원한다.
`SFUD_TOKEN_SECRET`이 설정되어 있으면 두 인증 저장소 모두 이 값을 우선 사용하며, 빈 값이나 잘못된 값일 때
파일 방식으로 자동 대체하지 않는다. 파일 방식만 사용하려면 SECRET 항목을 제거한다.
방식을 바꾸거나 문자열·키 버전을 변경해도 기존 토큰 암호문이 자동 변환되지는 않으므로,
이미 등록된 토큰이 있다면 기존 설정을 유지하거나 변경 후 각 토큰을 다시 등록한다.
기존 `SFUD_GIT_TOKEN_SECRET`과 `SFUD_SF_TOKEN_SECRET`은 공통 키가 없을 때만 호환용으로 사용한다. 기존 secrets.env는 자동으로 고치지 않는다. 기존 두 키의 값이 같았다면 그 값을 SFUD_TOKEN_SECRET으로 옮겨도 저장한 인증을 읽을 수 있다. 두 값이 달랐다면 단일 키로 이름만 바꾸어 통합할 수는 없으며, 기존 키를 유지하거나 새 공통 키로 해당 인증을 다시 등록해야 한다. 키나 DB를 자동 변환하지 않는다.

`SFUD_GIT_TOKEN_KEY_VERSION` 기본값은 1이다. 설정이 없거나 잘못되면 토큰 등록과 private 가져오기는
사용할 수 없으며 public 가져오기는 가능하다. DB와 암호화 설정은 안전하게 백업하고 복구 시 같은 값을 사용한다.

`GitClient`는 `GitCredentialProvider.getCredential()`만 호출한다. 현재 구현체는
`GithubPatCredentialProvider`, `GitlabPatCredentialProvider`, `BitbucketTokenCredentialProvider`다.
REST 자격 증명 생성은 Git transport와 분리한다. 이후 OAuth는 이 인터페이스의 새 구현체로 추가할 수 있다.

`SFUD_GIT_ENABLED=false`는 신규 토큰 등록, 저장소 조회와 공개·비공개 가져오기를 차단한다.
기존 이력과 준비된 배포 자료는 유지한다. migration 23은 이전 시험 버전의 OAuth 자격 증명을
PAT로 재해석하지 않고 재등록 상태로 바꾸며, Git 출처·승인 이력은 보존한다.
migration 25는 연결의 저장소 범위를 추가하며 기존 계정 연결은 그대로 유지한다.
Git 전용 연결의 저장소 식별자는 호스트와 경로의 해시(`git:` 접두어)이며 제공자 API의 숫자 ID/UUID와 구분한다.
저장소가 이동·개명되면 새 URL로 다시 등록해야 한다.

업그레이드 전 작업을 끝내고 서버를 정지한 뒤 SQLite와 run/artifact를 함께 백업한다.
구버전은 새 작업 ACL을 검사하지 않으므로 Git 이력이 생성된 새 DB를 구버전 웹 서버에 연결하지 않는다.
되돌릴 때는 업그레이드 전 백업을 별도 데이터 경로에 복원하고 새 DB·키·승인 자료는 보존한다.
