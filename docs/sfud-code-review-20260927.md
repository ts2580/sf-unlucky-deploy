# sf-unlucky-deploy — 최근 변경 중심 코드 검토

검토일: 2026-09-27

기준: `sf-unlucky-deploy-code-20260921-184047.zip` (0.3.0)

대상: `sf-unlucky-deploy-source-20260927-105438.zip` (0.4.0)

## 결론

이전 검토의 검증/실제 배포 단계 혼동, 불확실한 제출 분류, 체크섬 인코딩, 동시 로그인 제한은 수정된 동작을 격리 실행으로 확인했다. 비교·배포 소스 재사용, 대기열 진입 제한, 선택 manifest 작업 귀속도 코드에서 확인했다.

다음 수정 우선순위는 새로운 기능 확대가 아니라 **공용 서버의 사용자 경계**다. 신규 Org 실행 정책은 실제 Org ID가 아닌 별칭을 기준으로 하며, 미설정 별칭은 허용한다. Salesforce 실행 컨텍스트와 Org 기반 작업의 접근권한도 사용자별 비공개 모델로 완성되지 않았다.

이 보고서에서 “신규 결함”, “기존 동작이지만 공용 운영 요구와 충돌하는 설계”, “운영 정확성 보강”을 구분한다. P1은 공용 서버 운영 전 수정 우선, P2는 다음 안정화에 포함할 우선순위이며 CVSS 등급이 아니다.

## 범위와 검증 한계

두 압축본의 파일 내용으로 비교했다. Git 이력이 없으므로 특정 commit에 문제를 귀속하지 않는다. 파일 기준 39개 추가, 102개 변경, 2개가 새 ZIP에서 제외되어 있다. 제외된 README/THIRD_PARTY_NOTICES는 저장소에서 삭제되었다고 단정하지 않는다. 새 코드의 서버 TS 120개와 UI TS/TSX 29개, 관련 테스트·설정·SQL을 변경 경로 중심으로 검토했다.

npm registry DNS 접근이 실패하고 설치된 프로젝트 의존성이 없어 정식 typecheck, Vitest, Playwright, 전체 build, npm audit를 실행하지 못했다. Node 22.16.0의 내장 SQLite를 어댑터로 연결하여 원본 migration/repository SQL을 실행했고, TypeScript 5.8.3 transpileModule로 만든 검토용 모듈을 호출했다. TypeScript 변환 진단 0건은 의미·타입 검사 통과가 아니다. 제품은 TypeScript 7.0.2 및 sqlite/sqlite3를 선언한다.

실제 Salesforce Org나 외부 Git에 연결하지 않았다. 네트워크 결과는 합성 응답이며 CLI 환경 상속 테스트는 무해한 fake-sf를 실행했다. 토큰 유출·실제 무단 배포·운영 데이터 변조를 실시하지 않았다. 원본 ZIP과 제품 코드는 변경하지 않았다.

## 발견 사항 요약

| ID | 우선순위 | 구분 | 내용 | 확인 수준 |
|---|---|---|---|---|
| R1 | P1 | 신규 권한 정책의 조건부 우회 | Org 별칭 기준 정책 + 미설정 별칭 허용 | 원본 정책/WorkspaceService 격리 재현 |
| R2 | P1 | 공용 운영 요구 미완성 | 사용자별 Salesforce 인증·프로세스 컨텍스트 미분리 | 실제 ProcessSfClient 프로세스 실행 + 코드 추적 |
| R3 | P1 | 기존 공개 동작과 격리 요구 충돌 | Org/local 작업의 owner가 비어 다른 활성 사용자에게 노출 | 실제 repository/SQL 재현 + API 경로 추적 |
| R4 | P2 | 신규 비교 정확성 | 패키지 객체의 비네임스페이스 자식도 패키지 소유로 분류 | 원본 helper 재현, Org 미실행 |
| R5 | P2 | 신규 복구 증거 보강 | ADMIN 수동 연결 시 다른 시점의 배포도 현재 작업 성공에 연결 가능 | 실제 service/SQL + 합성 remote report |
| R6 | P2 | 기존 비밀번호 정책의 부분 개선 | scrypt 비용은 높였지만 인용한 권장 조합보다 낮음 | 코드/OWASP 기준 대조 |

## R1. Org 실행 정책은 별칭이 아니라 실제 Org에 귀속해야 한다

### 근거

- `src/storage/org-execution-access-repository.ts:19–33`: 정책/권한 키가 `target_alias`다.
- 같은 파일 `54–64`: ADMIN 및 비활성 사용자 처리 후, 정책이 없으면 즉시 허용한다. `60`줄에 단일 운영자 설치 호환 목적이 주석으로 명시되어 있다.
- `src/web/server/workspace-service.ts:277–305`: 전역 Org 목록을 별칭/사용자명으로 구성하며 실제 orgId로 중복을 제거하지 않는다.
- 같은 파일 `353–370`: 연결된 다른 별칭도 source로 해석할 수 있다.
- `src/deploy/deployment-service.ts:52–55,122–130`, `src/deploy/dry-run-service.ts:367–371`: 실행 정책을 확인하지만 기준은 여전히 별칭이다.

### 재현과 조건

실제 repository에 `prod-primary` 정책을 만들고 alice만 허용했다. bob은 이 별칭에서 거부되지만 정책이 없는 `prod-secondary`에서는 허용됐다. 별도 WorkspaceService 실행에서 동일 orgId에 연결된 두 Salesforce 사용자/별칭을 합성 목록으로 제공하면 두 항목 모두 노출되고 bob이 secondary를 해석할 수 있음을 확인했다.

```text
prod-primary  → orgId 00D…AAA → bob 거부
prod-secondary→ orgId 00D…AAA → 정책 없음 → bob 허용
```

실제 원격 배포는 하지 않았다. 이 경로에는 앱의 배포 역할과 **이미 인증되어 연결 목록에 존재하는 동일 Org의 두 번째 연결** 등이 필요하다. 임의의 존재하지 않는 별칭만 만들어 제출해도 무조건 통과한다는 의미가 아니다. 기존 Org identity 재확인은 요청 시작과 실행 사이의 연결 변경을 막지만, 처음부터 secondary로 요청하면 그 연결의 identity는 일치하므로 조직 단위 정책 누락을 보완하지 못한다.

### 수정

정책은 정규화된 Salesforce orgId로 조회하고 별칭은 표시/연결 선택에만 사용한다. 사용자별 인증 레코드는 별도로 소유권을 가진다. 로컬 호환 모드는 명시적으로 두고, 공용 서버 모드는 미설정 Org 실행을 기본 거부한다. 사용자 접근 검사와 실제 배포 직전 재검사를 유지한다. OWASP Authorization의 기본 거부 원칙은 이 수정 근거다 [A1].

추가 운영 문제: 마지막 grant를 지워도 enabled policy는 남고 `list()`는 grant만 반환하여 빈 배열이 된다. “정책 없음”과 “정책 활성, 허용자 없음”이 다르게 표시되어야 한다. `empty-policy-list`에서 확인했다.

## R2. Salesforce CLI 인증은 아직 사용자별·작업별 실행 컨텍스트가 아니다

### 근거

- `src/salesforce/sf-client.ts:7–13`: 실행 옵션에는 cwd/timeout/signal 등이 있지만 소유자가 검증된 인증 컨텍스트가 없다.
- 같은 파일 `74–84,235–238`: Git 비밀 관련 일부 변수를 제외하고 서버 `process.env`를 자식 프로세스에 상속한다. HOME 및 Salesforce 인증 관련 공용 환경은 별도 분리하지 않는다.
- `src/core/request-workspace.ts:12–27`: 요청용 디렉터리를 만들지만 인증 저장 영역을 분리하는 코드는 아니다.
- `src/web/server/workspace-service.ts:129–155,353–370`: Org 캐시와 연결 해석은 전역 구조다.
- `src/web/server/comparison-routes.ts:44–82`: workspace 응답에서 Git은 사용자 기준 필터링하나 Org 목록은 같은 모델이 아니다.

### 재현과 해석

실제 ProcessSfClient가 실행한 무해한 fake-sf에서 job-a/job-b의 cwd는 달랐고 HOME 및 테스트용 SF 환경변수 값은 같았다. 실제 토큰이나 인증 파일은 읽지 않았다.

```text
differentCwd = true
sameHome = true
sameInheritedSfVariable = true
```

이는 새로 생긴 인증 우회라고 분류하지 않는다. **기존 로컬/공유 SF CLI 모델이 사용자별 인증 격리 목표에 아직 도달하지 않았음**을 보여준다. 실제 CLI 토큰 사용까지 두 사용자로 시험한 결과는 아니다. 새 Org 실행 allowlist는 배포 인가를 추가했지만, 누가 어떤 Salesforce 자격증명을 사용할 수 있는지의 소유권 격리 자체는 아니다.

### 수정

`SfConnection(id, ownerUserId, orgId, username, credentialRef)` 정도의 최소 모델로 시작한다. 브라우저 입력의 소유자를 신뢰하지 않고 서버에서 현재 사용자와 대조한다. 조회/retrieve/validate/deploy/report 모두 검증된 connection을 받아야 한다. 자식 프로세스에는 필요한 변수만 허용하고, 작업별 인증 캐시/임시 디렉터리를 지정한다. 영속 credential과 작업 종료 시 지울 임시 auth 파일은 수명을 분리한다.

Salesforce 공식 CLI 문서가 설명하는 별칭/사용자명은 인증된 Org를 선택하는 식별자이지, 이 앱의 사용자별 권한 모델은 아니다 [A2].

중요한 제한: 같은 OS UID의 HOME/cwd 분리는 상태 혼입 방지용 논리 격리다. 악성 자식 프로세스가 같은 UID의 다른 파일을 읽지 못한다는 OS 보안 경계까지 제공하지 않는다. 실행할 수 있는 코드의 범위와 신뢰 모델을 명시하고, 필요하면 Runner 경계에서 OS 권한/샌드박스를 추가한다. 현재 범위에 팀·프로젝트·별도 테넌트 DB가 필요한 것은 아니다.

### 추가 설계: `LOCAL` 실행 모드와 사용자별 인증

이 절은 원래 요구사항과 구현 계획으로 작성했다. 아래의 구현 기록에 로컬 적용 상태와 검증 범위를 별도로 기록한다.

```dotenv
# 로컬 단독 사용: 로그인 없이 홈 화면을 열고 실행 OS 계정의 SF CLI 인증을 사용
LOCAL=true

# 공용 서버: 로그인 필수, 모든 사용자 인증과 자격증명을 사용자별로 분리
LOCAL=false
```

`LOCAL`은 `true` 또는 `false`만 허용하고, 미설정 시 `false`로 처리한다. 시작 시 한 번 결정하고 잘못된 값은 시작을 거부한다. `start-local.sh`의 `.env` 로더와 웹 서버 시작 경로가 `LOCAL`을 전달한다. `LOCAL=true`의 기본 데이터 디렉터리는 `.sfud-local`이며 `SFUD_DATA_DIR`로 변경할 수 있다.

| 설정 | UI와 앱 사용자 | Salesforce 인증 | 작업·연결 소유권 |
|---|---|---|---|
| `LOCAL=true` | 최초 설정·로그인 화면 없이 홈 화면을 연다. 내부 API에는 고정된 로컬 운영자 식별자를 사용한다. | 서버를 실행한 **같은 OS 계정**의 기존 `sf` CLI 인증 저장소에서 연결된 Org를 조회·사용한다. 앱 DB에 토큰을 복사하지 않는다. | 로컬 운영자에게 귀속하고 기존 접근 검사·기록을 거친다. |
| `LOCAL=false` 또는 미설정 | 기존 최초 설정·로그인 절차를 사용한다. | 각 앱 사용자가 소유한 SF connection만 선택·실행한다. 서버 프로세스의 전역 `sf` 로그인, HOME, 기본 Org를 대신 사용하지 않는다. | Salesforce·Git 연결, 작업, 실행 기록의 소유자를 현재 앱 사용자로 검증한다. 공유는 명시적 권한으로만 처리한다. |

`LOCAL=true`는 단일 사용자의 편의 기능이다. 리스닝 주소를 `127.0.0.1`로 고정하고 `--allow-remote`, 프록시/공개 Origin 설정은 무시한다. 요청의 Host·Origin을 검사하고, 로그인 화면을 생략해도 상태 변경 API의 CSRF 검사와 역할·작업 접근 검사는 유지한다. 브라우저에 SF CLI 인증 파일이나 토큰을 내보내지 않는다. 인증된 Org가 없으면 빈 홈 화면과 `sf` 로그인 안내를 보여주고, 다른 사용자의 자격증명으로 자동 대체하지 않는다. 루프백은 같은 기기의 다른 OS 사용자·프로세스를 차단하지 않으므로, 이 모드는 단독 사용 기기에서만 허용한다.

`LOCAL=false`에서는 **모든 인증을 사용자 단위**로 처리한다. 앱 로그인 세션, Salesforce connection과 실행 컨텍스트, Git 자격증명의 소유자가 요청 사용자와 일치해야 한다. `.env`에 둔 서버 암호화 키 같은 서비스 설정은 사용자 인증 수단으로 취급하지 않는다. 기존 환경변수 Git 토큰 가져오기 역시 지정된 소유자 외에는 사용할 수 없게 유지한다. Org 실행 허가는 별도이며 실제 orgId 기준 정책을 연결 소유권 검사와 함께 적용한다.

두 모드는 동일 DB의 기존 사용자·작업을 암묵적으로 합치거나 소유자를 바꾸지 않는다. 모드 전환 시에는 별도 데이터 디렉터리를 사용하거나, 기존 데이터가 다른 모드에 속하면 시작을 거부하고 명시적 마이그레이션을 요구한다. `LOCAL=true`에서 만든 작업을 `LOCAL=false`의 모든 사용자에게 공개해서는 안 된다.

인수 조건: `LOCAL=true`로 시작하면 원격 바인딩·프록시 설정이 있어도 `127.0.0.1`에만 바인딩하고 로그인 없이 홈 화면과 해당 OS 계정의 `sf` Org만 보인다. `LOCAL=false`에서는 미로그인 요청이 거부되고 사용자 A가 사용자 B의 SF/Git 연결, Org 작업, 결과, 배포 실행을 읽거나 사용할 수 없다. `true → false → true` 전환에서도 기존 소유권과 실행 이력이 섞이지 않는다.

### 추가 설계: `인증 관리` 탭

이 절도 원래 미구현 작업 요구사항으로 작성했다. 주 메뉴의 `인증 관리`에서 Salesforce와 Git 연결을 관리하고, `설정`에는 서버·비교 설정과 Git 가져오기·등록 브랜치·프로젝트 목록·관리자 허용 IP 정책을 둔다. 화면 이동으로 기존 Git 연결의 소유자와 토큰은 변경하지 않는다.

| 구역 | `LOCAL=true` | `LOCAL=false` |
|---|---|---|
| Salesforce | 실행 OS 계정의 SF CLI 인증 Org를 보여준다. 브라우저 로그인 버튼은 CLI 기본 OAuth URL을 사용하며, 헤드리스 서버는 SSH 콜백 포트 전달이 필요하다. | `Salesforce 연결`에서 본인 컴퓨터의 SF CLI 기본 웹 OAuth 로그인과 SFDX 인증 URL 등록 절차를 안내한다. 본인 연결 목록, Org ID·사용자명·상태, 재인증, 연결 해제를 제공한다. 다른 사용자의 연결은 목록·선택지·API에서 보이지 않는다. |
| Git | 로컬 운영자에 귀속된 기존 PAT/API Token 연결을 등록·교체·삭제한다. | 로그인한 앱 사용자 본인의 Git 연결만 등록·교체·삭제한다. 기존 제공자별 토큰 검증과 암호화 저장 방식을 유지한다. |

공용 모드의 Salesforce 연결도 **OAuth 웹 로그인**을 사용하지만, 별도 External Client App이나 sfud 전용 Connected App은 만들지 않는다. 사용자가 **본인 컴퓨터**의 Salesforce CLI에서 `sf org login web --alias <내-별칭>`을 실행하면 Salesforce CLI의 기본 `Salesforce CLI` Connected App으로 로그인할 수 있다 [A4]. 이어 `sf org auth show-sfdx-auth-url --target-org <내-별칭>`으로 얻은 SFDX 인증 URL을 인증 관리 화면의 일회성 비밀 입력란에 붙여 등록한다 [A5]. 프로덕션·샌드박스·My Domain 선택에 맞는 CLI `--instance-url` 안내를 제공한다. sfud 서버가 사용자 브라우저에서 OAuth callback을 직접 받는 한 번 클릭 흐름으로 표현하지 않는다. 기본 CLI 앱의 callback은 로컬 CLI 흐름이므로, 원격 서버의 웹 UI에 별도 앱 등록 없이 곧바로 연결할 수 있다고 가정하지 않는다.

SFDX 인증 URL에는 갱신 토큰이 포함되므로 비밀번호에 준해 취급한다 [A6]. 기본 `PlatformCLI` URL은 client secret 부분이 비어 있는 `force://PlatformCLI::<refreshToken>@<instance>` 형식도 가능하므로 이를 유효하게 처리한다 [A9]. 공개 주소의 등록 요청은 HTTPS에서만 받고, 루프백 주소의 개발 서버에서는 HTTP도 허용한다. 브라우저 저장소·URL·로그·작업 결과에 남기지 않으며 제출 직후 입력값을 지운다. 서버는 로그인한 앱 사용자 소유로만 암호화 저장하고, 연결 검증 시 실제 orgId·Salesforce 사용자명·인스턴스 URL을 확인한다. 사용자에게는 이 식별자와 연결 상태만 표시한다. 갱신 실패·철회·만료 시에는 그 연결만 `재인증 필요`로 표시하고, 사용자가 같은 CLI 웹 로그인·등록 절차를 반복하게 한다. 다른 사용자의 연결이나 서버 공용 SF CLI 인증으로 대체하지 않는다. 연결 해제는 앱의 저장된 자격증명을 제거하고, Salesforce 측 토큰 폐기는 별도 관리가 필요할 수 있음을 안내한다.

Salesforce 기본 Connected App은 기본 토큰 만료 정책이 느슨하므로 Org 관리자가 해당 앱의 갱신/액세스 토큰 정책을 설정하도록 안내한다 [A7]. Org 정책상 기본 Connected App 설치·승인이 불가능하거나 SFDX 인증 URL 사용이 제한되면 연결 실패를 명확히 알리고 공용 인증으로 우회하지 않는다. 특히 high assurance 인증이 강제된 Org에서는 SFDX URL을 이용한 비대화형 로그인 자체가 지원되지 않을 수 있다 [A2]. Salesforce CLI의 `org login device`는 제거된 명령이므로 대체 경로로 제시하지 않는다 [A8].

조회·비교·검증·배포·상태 조회는 요청 사용자 ID와 별칭으로 본인 연결을 찾고, 작업의 Org identity에 connection ID를 고정한다. 작업 중 연결 ID가 바뀌면 CLI 호출을 거부한다. Salesforce CLI 호출에는 작업별 임시 인증 저장소와 제한된 환경을 사용하며 서버 공용 HOME의 기본 Org를 참조하지 않는다. 동일 orgId에 여러 사용자 연결이 있어도 토큰과 작업 소유권은 각각 분리하고, orgId 기준 실행 허가를 별도로 확인한다. Git 연결도 요청 사용자 소유권을 확인한다. 연결 해제 시 완료된 기록은 보존하고, 진행 중 작업의 다음 인증 호출은 실패 또는 재확인 상태로 남긴다.

인수 조건: 새 탭에서 `LOCAL=false` 사용자 A가 본인 CLI의 기본 OAuth로 로그인하고 SFDX 인증 URL을 등록하면 A에게만 해당 Org가 나타나고 A의 작업만 그 연결을 사용한다. 사용자 B는 A의 connection ID로 목록·조회·비교·검증·배포·report를 요청해도 거부된다. 잘못된/만료된 인증 URL, 다른 사용자 연결 교체, 토큰 갱신 실패, 연결 해제 후 작업 처리도 확인한다. 기존 Git 연결은 화면 이동 후에도 소유자·암호문·교체/삭제 동작이 유지된다. `LOCAL=true`에서는 기존 SF CLI Org만 보이고 앱 DB에 인증 URL이 새로 저장되지 않는다. 실제 Salesforce Org 로그인·URL 등록·갱신 검증은 별도 원격 증거로 기록한다.

## R3. Org/local 기반 작업은 소유자가 비어 다른 사용자에게 공개된다

### 근거

- `src/compare/comparison-service.ts:147–149`: source/project ID 중 git/upload가 있을 때만 accessOwnerUserId를 지정한다.
- `src/deploy/dry-run-service.ts:135–137,303–305`: 검증 및 직접 배포도 같은 조건이다.
- `src/storage/job-access-repository.ts:14–19,30–43`: access_owner_user_id가 NULL이면 활성 사용자의 조회 및 해당 리소스 실행 접근 검사를 통과한다.
- `src/web/server/comparison-routes.ts:195–248,255–274`: 목록·상세·컴포넌트 응답이 이 접근 모델을 이용하며 비교 결과를 포함한다.

### 재현과 영향

```text
alice가 만든 Org 작업 → viewer READ = true
alice가 만든 Org 작업 → bob EXECUTE 리소스 검사 = true
alice가 소유한 Git 작업 → viewer READ = false
```

원본 repository/SQL로 확인했다. Org 비교 결과에는 파일 차이와 메타데이터 내용이 포함될 수 있으므로 단순 작업 제목 공유와는 다르다. 실제 HTTP 서버로 엔드포인트를 호출한 시험은 아니며 서비스가 만드는 owner 값과 API 접근 경로는 정적으로 추적했다.

리소스 EXECUTE 검사를 통과해도 별도의 역할/Org 실행 검사를 우회한 것은 아니다. 이를 비로그인 사용자나 VIEWER의 무제한 운영 배포 취약점으로 확대해석하면 안 된다.

이 동작이 원래 공유 콘솔 의도였다면 기존 설계다. 그러나 지금 목표인 사용자별 비공개 작업 공간과는 충돌한다. 인증 파일만 분리해도 이 결과 노출은 남는다.

### 수정

source 종류와 무관하게 모든 신규 작업의 owner를 현재 사용자로 설정한다. 공유는 이미 존재하는 명시적 job_access_grants로 처리할 수 있다. 기존 NULL 레코드는 created_by 등 증거로 소유자를 복구하고, 소유자를 확인할 수 없는 레코드는 관리자 검토 대상으로 두어 자동 공개되지 않게 한다. 관련 기준은 리소스별 접근 통제와 요청마다 권한 검증이다 [A1].

## R4. 패키지 제외가 패키지 소유 여부보다 넓게 적용된다

### 근거

- `src/metadata/package-exclusion.ts:87–90`: 이름을 `/[./-]/`로 나누고 어느 조각이라도 선택 namespace로 시작하면 제외한다.
- `src/metadata/comparator.ts:115–123`: 비교와 요약 전에 양쪽 component map에서 제거한다.
- `test/package-exclusion.test.ts:71–76`: `pkg__Object__c.Local__c → true`를 정답으로 두어 현재 넓은 분류를 테스트가 고정한다.
- UI `ui/src/comparison/PackageExclusions.tsx:35`: “비교에서 제외할 설치 패키지”라는 선택이다.

### 재현

| 합성 fullName | 현재 제외 여부 | “패키지 소유 항목만 제외”일 때의 기대 |
|---|---|---|
| pkg__Invoice__c.LocalNote__c | 제외 | 로컬 확장 필드라면 유지 |
| pkg__Invoice__c.pkg__ManagedNote__c | 제외 | 제외 |
| pkg__Invoice__c-Local Layout | 제외 | 로컬 레이아웃이라면 유지 |
| Account.LocalFlag__c | 유지 | 유지 |

원본 helper 동작은 확인했지만 실제 Salesforce Org의 해당 확장 메타데이터를 retrieve하지는 않았다. 소유권 시나리오는 이름이 네임스페이스 부모 아래 있다고 해서 그 자식도 패키지에서 제공됐다고 단정할 수 없다는 요구 해석이다.

### 수정

CustomField 등의 자식 메타데이터는 부모 객체의 namespace와 자식 멤버의 namespace를 분리한다. metadata type별로 소유 판단을 달리해야 하며, 모든 타입에 “마지막 문자열만 보면 된다”는 규칙도 안전하지 않다. 판단할 수 없으면 비교 결과에 남긴다.

만약 패키지 객체의 모든 로컬 확장까지 통째로 숨기는 것이 의도라면 계산 버그라고 부를 수는 없다. 대신 UI에서 제외 범위를 명시하고 제외 목록/개수를 제공해야 한다. 의도와 관계없이 현재의 포괄적 이름 판정은 일반 사용자가 기대하는 “설치 패키지 소유 변경 제외”보다 넓다.

## R5. 관리자 수동 복구에서 과거의 다른 배포를 현재 작업에 연결할 수 있다

### 근거

- `src/deploy/deployment-service.ts:178–220`: ADMIN, ID 형식, 근거 길이, 작업 상태, Org identity, 원격 ID/checkOnly를 확인한다.
- `206`줄은 관리자가 입력한 observedAt을 로컬 attempt 시작 시각과 비교한다. 원격 report의 createdDate와 로컬 시작 시각을 대조하는 검사는 없다.
- 같은 파일 `223–279`: 연결 후 원격 성공을 로컬 성공으로 기록한다.
- `src/deploy/deployment-attempt-repository.ts:112–155`: 연결 기록 및 감사 이벤트를 남긴다.

### 재현

원본 service/repository에 전날 만들어진 성공 배포 report를 합성해 제공했다. 관리자가 입력하는 observedAt은 현재 시각이고 근거는 최소 길이를 만족하게 했다.

```text
remote.createdDate = 로컬 attempt보다 하루 전
remote.checkOnly = false
remote.status = Succeeded
local 결과 = SUCCEEDED
executionEvidence = ATTEMPT_TRACKED
```

ADMIN 전용이고 감사 로그가 존재한다. 따라서 일반 사용자 권한 상승이 아니라, 실수로 잘못 붙인 원격 ID를 자동 검증된 현재 실행처럼 표시하는 **운영 증거의 정확성 문제**다. 실제 Salesforce가 해당 이전 report를 반환하는지까지 확인한 것이 아니라, 그러한 report가 주어졌을 때의 수용 동작을 검증했다.

### 수정

원격 createdDate 등 제공되는 제출 시각을 로컬 제출 의도와 대조하고 합리적 시계 오차만 허용한다. 동일 Org/원격 ID가 이미 다른 작업에 결합됐는지도 확인한다. 가능한 범위에서 구성요소/테스트 결과를 교차 확인한다. 시간 일치만으로 payload 동일성이 증명되지는 않는다.

수동으로 운영자가 보증한 결과를 허용하는 정책은 가능하다. 이 경우 MANUALLY_ATTESTED처럼 자동 추적과 증거 수준을 구분하고, 입력 근거와 검증하지 못한 항목을 감사 기록에 보존한다. Salesforce가 제공하지 않는 payload 해시를 검증할 수 있다고 가정하지 않는다.

## R6. 비밀번호 해시 개선은 부분 반영이다

`src/auth/password.ts:3–8`의 신규 조합은 N=32768, r=8, p=1이다. 비용을 높이고 기존 digest를 성공 로그인 후 바꾸는 경로가 추가됐다 (`src/auth/auth-service.ts:102–126`). 기존 계정 마이그레이션을 고려한 점은 코드에서 확인된다.

다만 OWASP Password Storage에서 N=2^15, r=8인 조합은 p=3을 제시한다 [A3]. 현재 p=1은 그 조합과 같지 않다. 이 지적은 DB 유출 이후 오프라인 추측 비용에 관한 것이며, 평문 저장이나 즉시 인증 우회가 아니다.

상수를 바꾸는 것만으로 끝내지 말아야 한다. `password.ts:69–85`는 저장된 p가 현재 상수와 같아야 허용하며 `passwordNeedsRehash():31–34`는 N만 비교한다. p를 바꿀 때는 기존 (N,r,p) 조합 허용과 전체 매개변수 기반 재해시 판단을 함께 고쳐야 한다. 실제 서버에서 지연·메모리와 로그인 동시성 한도를 측정하여 정책을 정한다.

## 이전 지적의 수정 여부

| 이전 문제 | 이번 확인 | 방법/근거 |
|---|---|---|
| dry-run 성공을 실제 배포 성공으로 복구 | VALIDATED_PENDING_EXECUTION 유지, 실제 배포 명령 없음 | 실제 DeploymentService + SQL, 합성 report |
| 제출 결과 불명확을 일반 실패로 분류 | ID 누락/시작 후 취소는 SF_EXTERNAL_STATE_UNKNOWN | 실제 제출 함수 호출 |
| 비교와 배포 소스 이중 수집 | deploymentSnapshot=sourceSnapshot | `src/commands/deploy.ts:163–165`, 정적 |
| 동시 로그인 실패 제한 우회 | 동시 10건 중 검증 5건, 401 5건/429 5건 | 실제 handler/AuthService/scrypt, DB 조회 대체 |
| 경로/내용 구분 모호한 체크섬 | 기존 충돌 사례 v1 같음, v2 다름 | 실제 sha256DirectoryV2 호출 |
| 무제한 대기열 | 예약·상한과 source 준비 전 admission 확인 | SingleJobQueue, ComparisonService, DryRunService 정적 |
| selected-manifest 중복/누적 | 멱등 요청 확인 선행, jobId 기반 input/package.xml | `dry-run-service.ts:95–118,517–530`, `selected-manifest.ts:40–48`, 정적 |

이 표의 “정적” 행은 전체 부하·장기 cleanup·실제 Org 배포의 성공을 보증하지 않는다. Quick Deploy 자격·attempt 분리 및 지속적 실행 lease도 변경 범위에 포함되지만 실제 Salesforce E2E는 미수행이다.

## 추가 코드 품질/운영 개선

### TS/React lint는 아직 제한된 패턴 검사다

`node scripts/lint-ts-react.mjs`는 149개 파일에서 통과했다. 그러나 `scripts/lint-ts-react.mjs:8–17`은 직접 async effect를 찾는 정규식 하나다. 전체 TypeScript/React 정적 분석으로 보아서는 안 된다. 필요 규칙부터 AST 기반 검사로 추가하고 스크립트 명칭/CI 출력이 보장 범위를 넘지 않도록 한다. `package.json`의 기본 lint는 여전히 mjs 대상이다.

### lockfile 검사는 dependency graph 비교이지 무결성 검증 전체가 아니다

`node scripts/check-lockfile-sync.mjs`는 통과했다. 스크립트는 resolved/integrity를 제외하고 정규화한다. 버전 그래프 동기화 확인 목적에는 부합하지만 다운로드 출처/무결성 동등성 검증까지 제공한다고 해석하면 안 된다. 필요하면 별도 release 검사로 관리한다.

### Node 최소 버전 선언을 실제 dependency engine과 맞춰야 한다

`package.json`의 node >=20.19와 lockfile의 commander 15 node >=22.12.0이 맞지 않는다. 이전 ZIP에도 있던 문제이므로 신규 회귀는 아니다. CI와 배포 이미지의 지원 버전을 하나로 맞추거나 호환 dependency를 선택한다. Node 20에서 실제 런타임 실패를 재현한 것은 아니다.

### 취약점으로 판정하지 않은 두 후보

Git 환경변수/시작 옵션의 허용 IP는 DB에서 지워도 유지된다. 코드가 가산 정책이고 UI `ui/src/git/GitAllowedIps.tsx:46,60`이 이를 설명하므로 삭제 우회 취약점이라고 판정하지 않았다. 유효 정책 전체를 출처별 표시하는 개선은 별개다.

lease 대기 중 취소를 coordinator만 떼어 실행하면 QUEUED 레코드가 남는다. 다만 runtime `src/web/server/runtime.ts:269–271`의 종료 경로가 interrupted job 복구를 호출하므로 영구 대기 버그라고 판정하지 않았다.

## 실행 결과와 마이그레이션

격리 스크립트는 총 15개 결과 그룹을 생성한다. 이는 독립적인 보안 취약점 15개 또는 공식 테스트 15개 통과를 의미하지 않는다. 세부 결과는 재현 ZIP의 JSON을 참조한다.

깨끗한 SQLite에 migration 41개를 적용했고 FK 위반은 없었다. schema 28에 대표 dry-run/deploy/grant를 넣고 41로 올린 시험에서 관계·소유자·grant는 보존됐다. legacy evidence/digest는 구분된 상태로 남았다. 실제 운영 DB나 모든 Git migration fixture에 대한 검증은 아니다.

## 최소 수정 순서와 인수 조건

1. Org 정책을 정규 orgId에 귀속하고 공용 모드 미설정 실행을 거부한다. 동일 Org의 두 연결에서도 허용 결과가 일치해야 한다.
2. 사용자 소유 SF connection과 작업 실행 컨텍스트를 연결한다. `LOCAL=false`의 기본 연결은 사용자 컴퓨터의 Salesforce CLI 기본 웹 OAuth와 SFDX 인증 URL 등록으로 만들고, 다른 사용자의 connection ID·공용 인증 상태로 조회/검증/배포/report를 수행할 수 없어야 한다.
3. 모든 source 종류의 job owner를 강제한다. 다른 사용자의 Org 비교 결과도 명시 grant 없이는 조회되지 않아야 한다.
4. `.env`의 `LOCAL=true|false`를 시작 경로에 연결한다. 로컬 모드는 루프백에서 로그인 없이 단일 운영자와 기존 SF CLI 인증을 사용하고, 공용 모드는 모든 인증·자격증명을 사용자별로 강제한다. 모드 전환 시 기존 데이터의 소유권을 보존한다.
5. `인증 관리` 탭에서 Salesforce와 Git 연결을 관리한다. 기존 Git 연결 UI를 이동하고 Salesforce CLI 기본 OAuth 등록 안내·인증 URL 입력·재인증·해제를 추가한다. 두 모드와 두 사용자에서 목록·API·작업 접근을 검증한다.
6. 패키지 제외의 소유 판단과 관리자 수동 복구의 증거 수준을 고친다. 로컬 확장 필드를 보존하거나 제외 범위를 명확히 고지하고, 다른 시점의 배포는 자동 추적 성공으로 표시되지 않아야 한다.
7. 비밀번호 매개변수 마이그레이션, 필요한 lint 규칙, Node 지원 버전을 정리한다.

이 수정은 사용자/인증/작업 세 축에서 가능하다. 팀·프로젝트·Git PR/MR 관리 기능 추가나 MSA 전환을 전제하지 않는다.

## 로컬 구현 기록 (2026-09-27)

위의 발견 사항과 재현은 **수정 전 ZIP의 상태**를 기록한 것이다. 현재 작업 트리에는 다음 변경을 적용했다. 운영 배포 또는 실제 Salesforce Org 인증을 검증했다는 뜻은 아니다.

| 항목 | 적용 내용 | 주요 경로 |
|---|---|---|
| R1 | Org ID를 18자리로 정규화한 실행 정책과 기본 거부. 기존 별칭 grant는 자동 허용하지 않고 관리자 검토 목록으로 격리 | `src/storage/org-execution-access-repository.ts`, `src/salesforce/org-identifier.ts`, migration 44, `ui/src/admin/AdminPage.tsx` |
| R2 | 사용자 소유 Salesforce 연결, 암호화된 SFDX 인증 URL, 요청 사용자별 임시 CLI HOME 및 연결 ID 고정 | `src/storage/salesforce-connection-repository.ts`, `src/salesforce/user-sf-client.ts`, migration 45, `src/web/server/salesforce-connection-routes.ts` |
| R3 | 모든 새 작업의 소유자 지정. 소유자 미상 작업은 비공개로 유지하고 관리자 검토 API 제공 | `src/storage/job-access-repository.ts`, migration 42, `src/web/server/admin-routes.ts` |
| R4 | 메타데이터 타입에 따라 패키지 소유 자식과 로컬 확장을 구분 | `src/metadata/package-exclusion.ts`, `src/metadata/comparator.ts` |
| R5 | 수동 재조정의 시각·ID 중복 검증과 `MANUALLY_ATTESTED` 증거 표시 | `src/deploy/deployment-service.ts`, `src/deploy/deployment-attempt-repository.ts` |
| R6 | scrypt 매개변수 상향 및 기존 해시의 점진적 갱신. Node 20 호환 Commander 14, Babel AST lint | `src/auth/password.ts`, `package.json`, `scripts/lint-ts-react.mjs` |
| 운영 모드 | `.env`의 `LOCAL=true|false` 파싱, 루프백 로컬 자동 로그인과 실행 OS 계정의 SF CLI 사용. 공용 모드에는 사용자별 연결만 사용 | `start-local.sh`, `src/cli/program.ts`, `src/web/server/app.ts`, migration 43 |
| 인증 관리 | `/auth`에 Salesforce와 Git 인증 연결 관리. `/settings`에는 Git 프로젝트 가져오기와 서버 설정 | `ui/src/App.tsx`, `ui/src/auth/SalesforceConnections.tsx`, `ui/src/git/GitSettings.tsx` |

`.env`에는 `LOCAL=false`와 무작위 `SFUD_SF_TOKEN_SECRET`을 추가했다. 암호화 키 값은 문서와 로그에 기록하지 않는다. `LOCAL=true`에서는 기존 공개 주소/프록시 설정을 무시하고 `127.0.0.1`에만 바인딩한다. 로컬 모드와 공용 모드는 데이터 디렉터리를 분리해야 한다. `LOCAL=true`에서 Salesforce 연결은 실행 OS 계정의 `sf org login web` 인증을 읽는다. `LOCAL=false`에서는 각 사용자가 자기 컴퓨터의 기본 CLI OAuth로 로그인하고 SFDX 인증 URL을 본인 계정에 등록한다. 앱용 External Client App을 만들거나 등록하지 않는다.

로컬 검증은 Codex CLI `gpt-6-luna` high로 실행했다. `npm run build`, `npm run typecheck`, `npm run quality`, 잠금 파일 dependency graph 검사, `git diff --check`가 통과했다. Vitest는 **75개 파일 524개 테스트 통과**, Playwright의 Git 가져오기·UI 두 spec은 **58개 통과**했다. 이 결과는 `IMPLEMENTED_LOCAL`이며 `VERIFIED_REMOTE`나 `DEPLOYED` 증거가 아니다. 실제 Salesforce Org의 OAuth 로그인·갱신·배포, 외부 Git 자격증명 사용은 수행하지 않았다.

## 외부 기준 출처

코드 사실의 근거는 각 절에 표시한 업로드 ZIP의 파일/줄 번호이며 source-provenance.json으로 원본을 확인할 수 있다. 아래 자료는 기준/플랫폼 의미 확인용이지 코드 실행 증거가 아니다. 확인일 2026-09-27.

[A1] OWASP Authorization Cheat Sheet — default deny, per-request/object authorization.
```text
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
```
[A2] Salesforce DX Developer Guide, Authorization — 인증된 Org 선택과 CLI 인증 수명.
```text
https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth.html
```
[A3] OWASP Password Storage Cheat Sheet — scrypt 조합, 비용 측정 및 점진적 재해시.
```text
https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
```
[A4] Salesforce CLI Command Reference — `sf org login web`은 기본 Connected App으로 웹 OAuth 로그인.
```text
https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_login_web.html
```
[A5] Salesforce CLI Command Reference — 웹 OAuth Org의 SFDX 인증 URL 조회.
```text
https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_auth_show-sfdx-auth-url.html
```
[A6] Salesforce CLI Command Reference — SFDX 인증 URL에 갱신 토큰이 포함되며 CLI 인증에 재사용 가능.
```text
https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_login_sfdx-url.html
```
[A7] Salesforce DX Developer Guide — 기본 `Salesforce CLI` Connected App의 토큰 정책 설정.
```text
https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-default-conn-app.html
```
[A8] Salesforce CLI Release Notes — `org login device` 제거.
```text
https://github.com/forcedotcom/cli/blob/main/releasenotes/README.md
```
[A9] Salesforce sfdx-core `AuthInfo.getSfdxAuthUrl()` — client secret 미설정 시 빈 필드로 내보내는 구현.
```text
https://github.com/forcedotcom/sfdx-core/blob/main/src/org/authInfo.ts
```
