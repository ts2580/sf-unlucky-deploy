# sf-unlucky-deploy

Salesforce org와 로컬 Salesforce DX 프로젝트의 메타데이터를 같은 형식으로 스냅샷화하고, 유무와 내용 차이를 확인한 뒤 검증·배포하는 TypeScript CLI다.

> 현재 상태: 비교·리포트·dry-run/배포 핵심 구현 완료. fixture, mock org와 실제 `aladin → stdOrg` check-only 검증을 통과했다.

## 아이디어의 출발점

이 프로젝트의 아이디어는 Aladin 프로젝트의 [classDeploy Lightning Web Component](https://github.com/ts2580/Aladin/tree/main/force-app/main/default/lwc/classDeploy)에서 시작했다. Salesforce 클래스 배포 경험을 org와 로컬 프로젝트 전반의 메타데이터 비교·검증·배포 흐름으로 확장한다.

## 제공 기능

- org ↔ org, local ↔ org, local ↔ local 비교
- 메타데이터 컴포넌트의 추가·삭제·변경·동일 상태 분류
- XML 경로별 이전 값·새 값, Apex/LWC unified diff, 바이너리 SHA-256 비교
- LWC와 Aura 등 여러 파일로 구성된 번들의 컴포넌트 단위 집계
- terminal, JSON, Markdown, raw diff, HTML 리포트
- org → org, local → org 배포
- 기본 dry-run과 명시적인 `--execute`
- staging payload 체크섬 고정 및 변경 시 배포 차단
- `*_Test.cls` 자동 선택과 Apex test level 전달
- Salesforce CLI 결과의 인증 토큰 로그 제거
- SQLite 기반 사용자·역할·승인·배포 상태·감사 로그 영구 저장
- 단일 배포 큐와 재시작 후 `RECONCILE_REQUIRED` 복구 상태

세부 설계와 진행 상태는 [작업 계획](./working/2026-08-22-salesforce-metadata-compare-deploy-plan.md)에서 관리한다.

## 요구 사항

- Node.js 20 이상
- npm
- Salesforce CLI v2 (`sf`)
- Git
- HTML 리포트 E2E 검증 시 Playwright Chromium

Salesforce 인증은 CLI의 인증 저장소에서 관리한다. access token, refresh token 또는 SFDX auth URL을 이 저장소에 기록하지 않는다.

```bash
sf org login web --alias dev
sf org login web --alias prod
sf org list
```

## 설치와 검증

```bash
npm ci
npx playwright install chromium
npm run verify
```

도움말은 TypeScript 소스에서 바로 실행할 수 있다.

```bash
npm run dev -- --help
npm run dev -- compare --help
npm run dev -- deploy --help
```

`compare --all-metadata`는 별도 `package.xml` 없이 `sf project generate manifest`로 양쪽
소스의 배포 가능 컴포넌트를 조회한다. 각 소스에서 생성한 manifest의 합집합을 공통 범위로
사용하므로 한쪽에만 있는 컴포넌트도 `ADDED` 또는 `REMOVED`로 탐지한다.

```bash
npm run dev -- compare \
  --left org:dev \
  --right org:prod \
  --all-metadata \
  --detail
```

한 metadata type만 비교하려면 `--metadata-type`을 사용한다. org 소스는 Salesforce 조회
단계부터 해당 타입으로 제한하고, 로컬 소스도 생성된 manifest에서 같은 타입만 사용한다.

```bash
npm run dev -- compare \
  --left org:dev \
  --right org:prod \
  --metadata-type ApexClass
```

org 소스는 현재 인증 사용자가 조회할 수 있고 Salesforce CLI가 manifest로 만들 수 있는
비패키지 메타데이터를 대상으로 한다. 로컬 소스는 `sfdx-project.json`의 모든
`packageDirectories`를 대상으로 한다. 생성된 개별 manifest, 합집합 `package.xml`, 타입별
디렉터리·suffix를 기록한 `metadata-types.json`은 해당 실행의 `generated-manifest/`에 남는다.

비교와 배포 명령은 요청마다 운영체제 임시 디렉터리에 빈 Salesforce DX workspace를 새로
초기화한다. `sf` 명령은 이 격리된 workspace에서 실행하며 요청의 성공·실패와 관계없이 종료
시 제거한다. snapshot, staging payload, 리포트와 로그는 승인 및 감사에 필요하므로 기존
`.sfud/runs/<실행-ID>/`에 보존한다.

빌드 결과는 `dist/`에 생성된다.

```bash
npm run build
node dist/cli.js --help
```

### GitHub Release 패키지 설치

GitHub Release에서 버전별 `.tgz`와 `SHA256SUMS`를 내려받아 설치할 수 있다. npm registry에는 발행하지 않는다.

```bash
sha256sum --check SHA256SUMS
npm install --global --allow-scripts=sqlite3 ./sf-unlucky-deploy-0.1.0.tgz
sfud --version
```

`sqlite3` native binding 설치 스크립트만 명시적으로 허용한다. Release는 `package.json`과 같은 버전의 annotated tag가 최신 `main` 커밋을 정확히 가리킬 때만 발행한다.

아래 예시의 `sfud`는 빌드된 CLI를 뜻한다. 개발 중에는 `sfud` 대신 `npm run dev --`를 앞에 사용하면 된다.

## 메타데이터 비교

소스는 다음 형식으로 지정한다.

| 형식 | 의미 |
|---|---|
| `org:<alias>` | Salesforce CLI에 인증된 org |
| `local:<path>` | `sfdx-project.json`이 있는 Salesforce DX 프로젝트 |

두 org 비교:

```bash
npm run dev -- compare \
  --left org:dev \
  --right org:prod \
  --manifest manifest/package.xml \
  --detail
```

현재 로컬 프로젝트와 org 비교:

```bash
npm run dev -- compare \
  --left local:. \
  --right org:prod \
  --manifest manifest/package.xml \
  --detail
```

두 로컬 DX 프로젝트 비교:

```bash
npm run dev -- compare \
  --left local:/path/to/project-a \
  --right local:/path/to/project-b \
  --manifest manifest/package.xml
```

비교 방향은 `left → right`다.

| 상태 | 의미 |
|---|---|
| `ADDED` | 오른쪽에만 존재 |
| `REMOVED` | 왼쪽에만 존재 |
| `MODIFIED` | 양쪽에 존재하지만 내용이 다름 |
| `IDENTICAL` | 양쪽의 구조와 내용이 동일 |

기본 XML 비교는 들여쓰기와 attribute 순서만 무시하고 값과 반복 element 순서를 비교한다. 원문 형식 차이까지 확인하려면 `--strict`를 사용한다.

CI에서 차이를 실패로 처리하려면 다음 옵션을 추가한다.

```bash
npm run dev -- compare \
  --left local:. \
  --right org:prod \
  --fail-on-diff
```

## 비교 리포트

실행 결과는 기본적으로 `.sfud/runs/<실행-ID>/`에 저장된다.

```text
.sfud/runs/<실행-ID>/
├── run.json
├── left/
│   ├── raw/
│   └── snapshot.json
├── right/
│   ├── raw/
│   └── snapshot.json
└── reports/
    ├── summary.md
    ├── summary.json
    ├── content.diff
    ├── report.html
    └── checksums.json
```

`report.html`은 별도 서버 없이 브라우저에서 열 수 있는 self-contained 문서다. `--report-dir <path>`로 한 실행의 저장 위치를 직접 지정할 수도 있다. 기존 파일이 있는 디렉터리는 덮어쓰지 않는다.

Profile과 PermissionSet은 같은 manifest에 포함된 메타데이터 범위 안에서만 비교 결과가 완전하다. 도구는 조회되지 않은 권한을 `false`로 추정하지 않는다.

## dry-run 배포

배포 명령은 `--execute`가 없으면 항상 dry-run만 수행한다. `--dry-run`을 명시해도 같은 동작이다.

org → org:

```bash
npm run dev -- deploy \
  --from org:dev \
  --to prod \
  --manifest manifest/package.xml \
  --dry-run
```

local → org:

```bash
npm run dev -- deploy \
  --from local:. \
  --to prod \
  --manifest manifest/package.xml \
  --dry-run
```

배포는 다음 순서를 따른다.

1. source와 target을 같은 manifest로 snapshot
2. 상세 차이와 HTML 리포트 생성
3. source staging payload SHA-256 확인
4. Salesforce dry-run 실행
5. `--execute`가 있을 때 payload SHA-256 재확인
6. dry-run에 사용한 동일 payload 실제 배포

배포 전 차이는 `target → desired source` 방향으로 표시한다. `ADDED`는 source에서 target에 추가할 항목이다. `REMOVED`는 target에만 존재하는 항목이지만 destructive manifest를 사용하지 않으므로 자동 삭제되지 않는다.

배포 관점의 UI에서는 이 의미가 더 직접적으로 드러나도록 `ADDED`를 `NEW`, `REMOVED`를
`TARGET ONLY`로 표시한다. 즉 source에만 있으면 새로 배포할 항목이고, target에만 있으면
자동 삭제 대상이 아닌 잔존 항목이다.

전체 배포 가능 metadata를 동적으로 검증하려면 manifest 대신 다음 옵션을 사용할 수 있다.

```bash
npm run dev -- deploy \
  --from org:dev \
  --to prod \
  --all-metadata \
  --dry-run

npm run dev -- deploy \
  --from org:dev \
  --to prod \
  --metadata-type ApexClass \
  --dry-run
```

dry-run 성공 후 실제 배포하려면 다음처럼 실행한다.

```bash
npm run dev -- deploy \
  --from local:. \
  --to prod \
  --manifest manifest/package.xml \
  --execute
```

`--dry-run`과 `--execute`를 동시에 지정하면 실행 전에 실패한다.

## Apex 테스트 선택

기본 `--test-level`은 `auto`다.

1. `--tests`로 지정한 클래스가 있으면 해당 클래스 사용
2. 지정하지 않았다면 staging의 `classes/*_Test.cls` 자동 선택(접미자 대소문자 무시)
3. 하나 이상 발견하면 `RunSpecifiedTests`로 전달
4. 발견하지 못하면 `RunLocalTests`로 fallback

자동 선택 예시:

```text
AccountService_Test.cls
OrderService_Test.cls
```

```bash
npm run dev -- deploy \
  --from local:. \
  --to prod \
  --dry-run
```

테스트를 직접 선택할 수도 있다.

```bash
npm run dev -- deploy \
  --from local:. \
  --to prod \
  --test-level RunSpecifiedTests \
  --tests AccountService_Test OrderService_Test \
  --dry-run
```

지원하는 test level:

```text
auto
NoTestRun
RunSpecifiedTests
RunLocalTests
RunAllTestsInOrg
RunRelevantTests
```

실제로 선택된 수준과 테스트 클래스는 터미널과 `<run>/logs/test-plan.json`에 기록된다.

## manifest

[기본 manifest](./manifest/package.xml)는 API 67.0 기준의 일반적인 배포 가능 메타데이터를 포함한다. 비교와 배포 양쪽에 반드시 같은 manifest를 사용한다.

전체 org를 무조건 wildcard로 조회하는 것은 안정적이지 않다. 비교 목적에 맞게 manifest를 작게 나누는 것을 권장한다.

```text
manifest/apex.xml
manifest/objects.xml
manifest/permissions.xml
```

diff 결과만으로 destructive deployment를 자동 생성하거나 실행하지 않는다.

## 웹 UI와 SQLite 상태 저장소

웹 UI는 사용자·권한·배포 승인·작업 상태와 감사 로그를 SQLite에 저장한다. 기본 위치는 현재 프로젝트의 `.sfud/sfud.db`다. 비교 리포트와 원본 실행 결과는 기존 `.sfud/runs` 파일 구조를 유지하며 데이터베이스에는 인덱스와 무결성 정보만 기록한다.

```bash
npm run build
node dist/cli.js ui --no-open
```

프로젝트 루트의 로컬 실행 스크립트는 기본 포트 `27546`을 점유한 기존 LISTEN 프로세스를
종료한 뒤 UI를 시작한다. 빌드 결과가 없으면 자동 빌드하지 않고 먼저 `npm run build`를
실행하라는 오류를 표시한다.

```bash
./start-local.sh

# 다른 로컬 주소나 포트 사용
SFUD_UI_HOST=192.168.0.62 SFUD_UI_PORT=27546 ./start-local.sh
```

loopback이 아닌 주소에는 스크립트가 `--allow-remote`를 자동으로 추가한다. 추가 CLI 옵션은
스크립트 뒤에 그대로 전달할 수 있다. 예: `./start-local.sh --project /path/to/project`.

셀프 호스팅에서는 영속 volume의 디렉터리를 명시한다.

```bash
node dist/cli.js ui \
  --host 0.0.0.0 \
  --allow-remote \
  --project /srv/salesforce/project-a \
  --project /srv/salesforce/project-b \
  --data-dir /var/lib/sfud \
  --no-open
```

`--project`는 반복해서 지정할 수 있으며 이 경로만 **서버 프로젝트**로 노출된다. 옵션을
생략하면 등록되는 서버 프로젝트가 없으며, 서버를 시작한 현재 디렉터리를 자동으로 비교
소스에 넣지 않는다. 웹 API는 allowlist 밖의 서버 경로와 manifest를 거부한다.

브라우저의 **내 프로젝트 업로드**는 접속한 단말기에서 선택한 Salesforce DX 폴더를 서버의
사용자별 임시 디렉터리로 전송한다. 업로드 프로젝트는 마지막 비교 또는 dry-run 사용 후
4시간이 지나거나 서버 프로세스가 종료되면 제거된다. 업로드는 파일 2,000개, 파일당 10MB,
전체 100MB로 제한하며 `.git`, `.sf`, `.sfdx`, `node_modules`, `.env`와 일반적인 비밀키 파일은
받지 않는다. 서버 프로젝트는 경로 참조이고 업로드 프로젝트는 임시 복사본이므로 서로 다른
소스 유형이다.

`SFUD_DATA_DIR` 환경변수로도 저장 위치를 지정할 수 있다. 데이터 디렉터리는 `0700`, DB 파일은 `0600` 권한으로 제한하며 다음 설정을 적용한다.

```text
foreign_keys = ON
journal_mode = WAL
busy_timeout = 5000ms
```

사용자가 없으면 서버 시작 로그에 일회용 `최초 관리자 설정 코드`가 표시된다. 웹 화면에서 이 코드와 이메일, 표시 이름, 12자 이상의 비밀번호를 입력해 첫 `ADMIN` 계정을 만든다. 자동화된 설치에서는 환경변수로 코드를 고정할 수 있다.

```bash
SFUD_BOOTSTRAP_TOKEN="충분히-긴-일회용-설정-코드" \
node dist/cli.js ui --no-open
```

최초 관리자가 생성되면 해당 코드는 더 이상 사용할 수 없다. 비밀번호는 `scrypt`로 해시하고 세션·CSRF 토큰은 SHA-256 해시만 SQLite에 저장한다. 세션 쿠키는 `HttpOnly`, `SameSite=Strict`이며 HTTPS reverse proxy에서는 `Secure` 속성도 적용된다. Nginx 등 reverse proxy는 원래 `Host`와 `X-Forwarded-Proto` 헤더를 전달해야 한다.

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

인증된 사용자만 배포 작업 이력 API에 접근할 수 있고, 로그아웃을 포함한 상태 변경 요청은 동일 출처와 CSRF 토큰을 모두 검증한다. OIDC는 셀프 호스팅 로컬 계정과 병행할 수 있는 후속 인증 공급자로 추가한다.

### 웹 비교 및 dry-run

`OPERATOR`, `DEPLOYER`, `ADMIN` 사용자는 웹의 **비교 및 배포** 화면에서 desired source와
target org를 선택하고, 비교가 성공하면 같은 범위로 Salesforce check-only를 실행할 수 있다.
desired source는 `--project`로 등록한 서버 프로젝트, 브라우저에서 임시 업로드한 내 단말기
프로젝트, 또는 다른 Salesforce org 중에서 선택한다.

비교 결과의 체크박스로 metadata 컴포넌트를 **배포 대상**으로 선택할 수 있다. metadata type을
바꿔 검색해도 같은 desired source와 target org를 사용하는 동안 선택 목록은 유지된다.
체크를 해제하거나 배포 대상의 제거 버튼을 누르면 목록에서 빠진다. target에만 존재하는
`TARGET ONLY` 항목은 desired source에 payload가 없으므로 선택할 수 없다.

배포 대상의 **Dry-run** 버튼은 선택한 컴포넌트만 포함한 전용 `package.xml`을 만들고 Salesforce
check-only를 실행한다. 성공한 dry-run은 staging payload와 SHA-256을 고정한다. `DEPLOYER` 또는
`ADMIN` 사용자가 대상 org 별칭과 `실제 배포` 확인 문구를 입력한 경우에만 실제 배포 버튼이
활성화되며, 서버는 배포 직전에 staging payload SHA-256을 다시 확인한다.
서버는 `sf org list --json` 결과에서 별칭, 표시 이름, edition, 연결 상태만 추출하며
토큰·client ID·키 경로·로컬 절대 경로를 API에 반환하지 않는다.

기본 비교 범위는 **전체 배포 가능 메타데이터 (SF CLI)**다. 서버가 LEFT와 RIGHT 각각의
manifest를 동적으로 생성하고 합집합을 사용하므로 로컬 프로젝트의 `package.xml`에 의존하지
않으며 실행 프로젝트를 선택할 필요도 없다. 비교 범위 combobox는 선택한 org가 지원하는
Salesforce metadata type 전체를 합집합으로 제공하며 이름 검색과 단일 타입 비교를 지원한다.

비교 요청은 SQLite에 먼저 `QUEUED` 상태로 기록한 뒤 별도 단일 큐에서 기존
`runCompareCommand` 코어를 실행한다. **비교 옵션과 Apex 테스트** 섹션에서 비교를 시작하며,
별도 **실행 현황** 섹션이 비교·Dry-run·실제 배포 상태를 함께 표시한다. 인증된
`GET /api/v1/workflow/events` SSE는 job ID·종류·상태만 전달하고, 브라우저는 이벤트를 받으면
해당 작업 상세를 다시 조회한다. SSE 연결이 끊겨도 기존 polling이 최종 상태 확인을 계속한다.
완료되면 `NEW`·`TARGET ONLY`·`MODIFIED`·`IDENTICAL` 요약과 컴포넌트별 파일 diff를 표시한다.
Dry-run도 package.xml을 다시 요구하지 않고 선택한 전체 또는 단일 metadata type 범위의
합집합 manifest를 요청마다 새로 생성한다. `VIEWER`는 이력만 조회한다.

작업은 SQLite의 `QUEUED → DRY_RUN_RUNNING → APPROVAL_PENDING | FAILED | RECONCILE_REQUIRED` 상태를 사용한다. snapshot과 비교가 끝난 실제 staging payload SHA-256, 비교 결과, 자동 또는 명시적으로 선택된 Apex 테스트, 정제된 Salesforce 결과를 함께 저장한다. 준비 전 요청 지문은 API에서 payload checksum으로 노출하지 않으며 `prepared=1`인 성공 작업만 다음 실제 배포 승인 단계로 넘길 수 있다.

실제 `aladin → stdOrg` 검증에서는 독립 Apex 클래스 1개가 `checkOnly: true`, `status: Succeeded`, `executed: false`로 완료됐다. 의존성이 빠진 LWC manifest는 Salesforce 오류를 `FAILED`로 정확히 기록했으며 실제 반영은 발생하지 않았다.

배포 작업은 한 번에 하나만 실행하고 다음 상태를 영구 기록한다.

```text
dry-run: QUEUED → DRY_RUN_RUNNING → APPROVAL_PENDING | FAILED | RECONCILE_REQUIRED
deploy:  QUEUED → DEPLOYING → SUCCEEDED | FAILED | RECONCILE_REQUIRED
```

실제 배포 승인은 성공한 dry-run, 동일한 payload SHA-256, 동일한 target org, `DEPLOYER` 또는 `ADMIN` 역할과 `실제 배포` 확인 문구를 모두 요구한다. Salesforce access token과 auth URL은 SQLite에도 저장하지 않는다.

## 개발 명령

| 명령 | 설명 |
|---|---|
| `npm run dev -- <args>` | TypeScript 소스에서 CLI 실행 |
| `npm run typecheck` | CLI와 E2E TypeScript 검사 |
| `npm test` | Vitest 단위·fixture 테스트 |
| `npm run test:e2e` | Playwright HTML 리포트 테스트 |
| `npm run build` | `dist/` 빌드 |
| `npm run check` | 타입 검사, Vitest, 빌드 |
| `npm run verify` | 타입 검사, Vitest, Playwright, 빌드 전체 검증 |

## 브랜치 승격 규칙

기능은 다음 순서로 승격한다.

```text
feat/* 또는 fix/* → canary → main
```

- 기능 브랜치에서 구현과 fixture 검증
- `canary` 병합 후 전체 검증
- `main` 병합 전 canary 결과 재확인
- 기능 단위로 커밋하고 작은 중간 커밋을 남발하지 않음

## 현재 검증 범위

- TypeScript 타입 검사
- Vitest 단위·fixture 테스트
- mock `sf` 기반 org ↔ org 비교와 배포 안전장치
- 실제 Salesforce CLI 기반 local ↔ local source 변환·비교
- Playwright Chromium 기반 데스크톱·모바일 HTML 렌더링

실제 org 전체 범위 검증은 배포 대상과 manifest를 명시적으로 정한 뒤 수행한다. 저장소 검증에서는 작은 단일 컴포넌트 check-only만 실행한다.
