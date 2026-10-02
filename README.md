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

- Node.js 22.19.0 이상 (Node.js 24 LTS 권장)
- npm
- Salesforce CLI v2 (`sf`)
- Git
- HTML 리포트 E2E 검증 시 Playwright Chromium

독립 실행 CLI와 `LOCAL=true` 웹 모드는 실행 OS 계정의 Salesforce CLI 인증 저장소를 사용한다. `LOCAL=false` 웹 모드는 사용자별 SFDX 인증 URL을 앱 DB에 암호화 저장한다. 인증 원문은 Git 저장소에 기록하지 않는다.

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

CI와 개발 설치는 `package-lock.json`을 기준으로 `npm ci`를 수행하고, 배포 tarball에는
`npm-shrinkwrap.json`을 포함한다. 두 파일의 dependency graph는 `npm run lockfile:check`로
동기화를 확인한다. 패키징과 릴리스 설치 검증은 `packageManager`에 고정한 npm 11.20.0으로
수행해 서로 다른 로컬 npm 버전이 배포 dependency tree를 바꾸지 않게 한다.

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

### npm 배포 준비 상태

npm 패키지 이름은 `@trstyq/sf-unlucky-deploy`이고 실행 명령은 `sfud`입니다. 시험판은 `next` 채널로 설치하며 프로젝트 라이선스는 MIT입니다. 특정 시험판을 고정하려면 `@next` 대신 발행된 버전 번호를 지정하세요.

```bash
npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@next
sfud --version
sfud --help
```

Salesforce CLI v2(`sf`)와 Git은 별도로 설치하고, 필요한 Org를 미리 로그인해야 합니다. 설치된 `sfud`는 현재 디렉터리의 `.env`를 자동으로 읽지 않습니다. `0.4.0-rc.2`부터 `sfud ui`, `sfud compare`, `sfud deploy`를 처음 실행하면 사용자 홈에 `.sfud/config.json`과 `.sfud/secrets.env`를 자동으로 생성합니다. Linux의 기본 경로는 `~/.sfud/config.json`, Windows는 `%USERPROFILE%\.sfud\config.json`입니다. npm 설치 시에는 생성하지 않으므로 설치 스크립트를 끈 환경에서도 첫 실행 시 동작합니다. `--help`, `--version`, `config path` 조회는 파일을 만들지 않습니다. 이전 시험판 `0.4.0-rc.1`은 자동 생성을 지원하지 않으므로 아래 초기화 명령이 필요합니다.

자동 생성 파일은 `{ "version": 1, "env": {} }`로 시작하여 현재 실행 모드와 데이터 경로를 유지합니다. 기존 설정은 덮어쓰거나 권한을 자동 변경하지 않습니다. 설정이 없을 때 개인 LOCAL 모드를 명시적으로 초기화하려면 다음 명령을 사용합니다.

```bash
sfud config path
sfud config init
```

`sfud config init`으로 만든 개인 설정은 `LOCAL=true`와 설정 디렉터리 기준 `data/local`을 사용합니다. 자동 생성된 빈 설정이 이미 있다면 `config path`가 표시한 파일의 `env`에 이 값을 직접 설정하세요. 실행 옵션이 가장 우선하고, 그 다음 현재 프로세스 환경변수, 홈 설정, 기본값 순서로 적용됩니다. `SFUD_CONFIG_DIR`에는 설정 디렉터리의 절대 경로를 지정할 수 있습니다. 자동 생성 설정이 비어 있으면 기존 기본 동작을 유지합니다.

일반 설정 파일은 버전 1의 제한된 환경 변수만 받습니다. 예를 들면 다음과 같습니다.

```json
{
  "version": 1,
  "env": {
    "LOCAL": "true",
    "SFUD_UI_PORT": "27546",
    "SFUD_DATA_DIR": "data/local"
  }
}
```

`LOCAL=true`에서는 OS 사용자의 Salesforce CLI 인증을 사용하므로 Salesforce 인증에 암호화 키가 필요하지 않습니다. Git 토큰을 저장하려면 로컬 모드에서도 `SFUD_TOKEN_SECRET`이 필요합니다. `LOCAL=false`에서 사용자별 Salesforce 연결을 저장하려면 이 암호화 키를 설정해야 합니다. 빈 값은 유효하지 않은 키로 처리되며, 프로세스에 빈 환경변수가 있으면 비밀 설정 파일의 값보다 우선합니다.

비밀값은 `config.json`에 넣지 마세요. 다음 배포부터 `~/.sfud/secrets.env`는 첫 실행과 `config init`에서 사용자 전용 권한으로 자동 생성합니다. 기존 config.json만 있는 경우에도 누락된 secrets.env를 만들며, 기존 비밀값 파일은 덮어쓰지 않습니다. 자동 생성 내용은 항목 안내 주석뿐이고 비밀값을 생성하거나 빈 환경변수를 활성화하지 않습니다. 사용할 항목의 주석을 풀고 실제 값을 넣으세요. `secrets.env`에는 `SFUD_TOKEN_SECRET`, `SFUD_SF_OAUTH_CLIENT_ID`, `SFUD_SF_OAUTH_CLIENT_SECRET`을 사용합니다. 이전 두 개별 암호화 키 이름도 호환용으로 허용합니다. POSIX에서는 새 파일을 `umask 077` 상태에서 만들고 `chmod 600 ~/.sfud/secrets.env`인지 확인한 뒤 편집하세요. 기존 설정의 권한이 안전하지 않으면 `sfud`가 읽기를 거부하므로 권한을 직접 점검하세요. UI 호스트를 루프백 밖으로 설정해도 원격 bind에는 계속 `--allow-remote`가 필요하며 `LOCAL=true`는 루프백으로 고정됩니다.

개인 로컬 웹 UI는 설정에 저장되므로 매번 `LOCAL=true`를 명시하지 않아도 됩니다. 셸에서 직접 환경변수로 덮어쓸 수도 있습니다.

```bash
# POSIX 셸
LOCAL=true sfud ui
```

```powershell
# PowerShell
$env:LOCAL = 'true'
sfud ui
```

업그레이드 전에는 서버를 종료하고 데이터 디렉터리와 암호화 키를 백업하세요. 데이터베이스를 이전 버전으로 되돌려 열 수 있다고 가정하지 마세요.

### GitHub Release 패키지 설치

현재 사용할 수 있는 설치 경로다. 공개 GitHub Release `v0.3.0`의 `.tgz`와 `SHA256SUMS`를 내려받아 설치한다. `0.4.0`은 아직 공개 Release가 아니다. npm registry에 같은 버전이 공개되기 전까지 npm 설치는 사용할 수 없다.

```bash
sha256sum --check SHA256SUMS
npm install --global --allow-scripts=sqlite3 ./sf-unlucky-deploy-0.3.0.tgz
sfud --version
```

`sqlite3` native binding과 `esbuild`의 설치 스크립트만 명시적으로 허용한다. npm 12에서는 lockfile의 resolved identity를 사용할 수 없는 경우가 있으므로 `allowScripts` 키는 버전을 붙이지 않은 패키지 이름으로 유지한다. Release는 `package.json`과 같은 버전의 annotated tag로 발행한다. RC 태그(`vX.Y.Z-rc.N`)는 최신 `canary`, 정식 태그(`vX.Y.Z`)는 최신 `main` 커밋을 정확히 가리켜야 한다.

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

기본 XML 비교는 들여쓰기와 attribute·서로 다른 자식 태그의 나열 순서를 무시하고 값을 비교한다.
XML 선언·처리 지시는 기본 의미 비교에서 무시하며 strict 원문 비교에는 포함한다.
반복 태그가 한쪽은 객체(1개), 다른 쪽은 배열(여러 개)로 파싱되어도 collection으로 맞춰 비교한다.
Profile·PermissionSet의 등록된 권한 목록, CustomObject의 fields·recordTypes·validationRules 등,
CustomLabels.labels는 식별 키로 대응시켜 반환 순서 차이를 무시한다. Layout의 배치 순서와
Picklist 값 순서는 보존한다. 미등록 collection은 순서가 의미 있다고 간주하며 중복 식별 키는
임의로 합치거나 버리지 않는다.

텍스트는 UTF-8 BOM, CRLF/CR/LF 형식, 마지막 줄바꿈 유무의 차이를 비교할 때만 정규화한다.
원본 파일과 원문 해시는 유지하며, 추가 빈 줄이나 공백·코드 변경은 계속 구분한다. `--strict`도 이 정규화는 유지하면서
XML 원문 형식·순서 차이를 추가로 비교한다. 1 MiB 초과 XML도 SAX 스트리밍과 노드별 SHA-256으로
끝까지 구조 비교하며 동일한 collection 순서 정책을 적용한다. 상세 결과는 루트의 자식 항목 단위로
최대 2,000건, 값 미리보기는 500자로 제한한다. 하위 변경은 항목 요약으로 표시하고 생략 사실을 알린다.
대형 파일의 unified diff는 생성하지 않지만 strict 판정에는 정규화한 원문 전체를 사용한다.
일반 대형 텍스트는 UTF-8 정규화 해시로 비교한다. 비교 정규화는 원본 파일과 payload SHA-256을 변경하지 않는다.

비교 옵션의 **비교에서 제외할 설치 패키지** 목록에서 패키지를 개별 선택한다.
연결된 Org의 설치 패키지를 이름·네임스페이스·설치 Org와 함께 표시하며 같은 패키지는 하나로 합친다.
선택한 패키지 ID를 작업 이력에 저장하고 비교 실행 시 설치 여부를 다시 확인하여 해당 컴포넌트를
Source와 Target 양쪽에서 제외한다. 기본값은 선택 없음이며, Org가 하나 이상 필요하다.
제외는 결과 집계·파일 수 상한·Source 목록에도 적용하고 원본 파일과 배포 payload는 변경하지 않는다.
선택을 바꾸면 기존 비교 결과와 배포 장바구니를 초기화하며, Org 구성이 바뀌면 선택도 초기화한다.
결과에 선택한 패키지·네임스페이스·제외 컴포넌트 수를 기록한다. 네임스페이스가 없거나 여러 패키지가
같은 네임스페이스를 공유하면 개별 식별이 불가능하므로 선택을 비활성화하고 사유를 표시한다.
Profile 등 유지된 컴포넌트 내부의 패키지 참조는 삭제하지 않는다. 선택한 패키지가 사라지거나
목록 조회에 실패하면 제외를 무시하지 않고 작업을 실패로 처리한다. 미선택 항목은 기존 비교 범위를
유지하며 Salesforce CLI가 기본 제외하는 패키지를 강제로 가져오지는 않는다.
CLI 개별 선택은 `sfud compare --excluded-package-ids 033... 033...`이며,
기존 전체 제외 옵션 `--exclude-package-metadata`와 함께 사용할 수 없다.

CustomField·CustomLabel 등의 MDAPI 부모 XML 분리는 파일로 스트리밍하며 이전의 16 MiB 제한을 적용하지 않는다.
메모리 보호를 위해 대형 XML 쌍은 한 번에 하나씩 비교한다. XML 중첩 깊이는 128,
비교 도중 동시에 보관하는 노드 요약은 문서당 100,000개로 제한하며 초과 시 명시적으로 실패한다.
DTD는 지원하지 않으며 SAX 파서의 태그·속성·주석 등 토큰 버퍼 상한은 약 64 KiB다.
텍스트·CDATA는 청크로 처리하므로 이 토큰 상한이 전체 XML이나 필드 값의 크기 제한은 아니다.

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

웹 UI에서는 설정의 **배포 테스트 규칙**에서 사용자별 테스트 클래스 접미사를 변경할 수 있다.
기본값은 `_Test`이며, 저장한 접미사는 이후 해당 사용자가 실행하는 Auto dry-run에 적용된다.

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

프런트엔드는 `deployment`, `comparison`, `auth`, `admin` 기능 단위로 나뉜다. 배포 요청과 응답은
TypeBox schema를 서버와 UI가 공유하며 Fastify와 브라우저 API client가 같은 계약을 runtime에
검증한다. 공통 client는 CSRF header, 401 알림, 오류 응답, timeout·abort와 직접 배포
idempotency key를 한곳에서 처리한다.

```bash
npm run build
node dist/cli.js ui --no-open
```

프로젝트 루트의 로컬 실행 스크립트는 기본 포트 `27546`을 점유한 기존 LISTEN 프로세스를
종료한 뒤 UI를 시작한다. 빌드 결과가 없으면 자동 빌드하지 않고 먼저 `npm run build`를
실행하라는 오류를 표시한다.

```bash
./start-local.sh
```

`start-local.sh`는 프로젝트 루트의 `.env`를 Node.js의 dotenv parser로 읽고 `LOCAL`과 `SFUD_*` 값을
기존 셸 환경변수보다 우선 적용한다. `.env`에 없는 변수는 셸 값을 사용한다. Windows용 `sfud.ps1`은 `LOCAL`과 `SFUD_*`를 읽되
기존 PowerShell 환경변수를 `.env`보다 우선 적용한다. 실제 `.env`는 Git에서 제외되므로
`.env.example`을 복사해 실행 모드와 접속 주소를 관리한다. 예를 들어 LAN 접속에는 `LOCAL=false`와
`SFUD_UI_HOST=192.168.0.62`를 `.env`에 설정하고 사용자별 로그인을 사용한다.
`LOCAL=true`에서는 `SFUD_UI_HOST`, `SFUD_PUBLIC_ORIGIN`, `SFUD_TRUSTED_PROXIES`와 원격 접근 옵션을 무시하고 127.0.0.1에만 바인딩한다.

Windows의 Salesforce CLI는 PATH에 등록한 공식 npm 설치 또는 Windows 설치 프로그램의
Node 진입점을 찾아 셸 없이 실행한다. npm의 `node_modules/@salesforce/cli/bin/run.js`와
설치 프로그램의 `client/bin/run`·bundled Node, `%LOCALAPPDATA%/sf/client/bin` 업데이트를 지원한다.
`&`, `%`, 공백 등이 있는 경로도 인자 그대로 전달하며, 진입점을 찾지 못하면 `cmd.exe`로
재시도하지 않고 설치/PATH 확인 오류를 표시한다. Linux에서는 기존처럼 `sf`를 직접 실행한다.

```bash
cp .env.example .env
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

브라우저의 **Git 프로젝트 가져오기**는 저장소의 고정 commit을 사용자별 임시 디렉터리에
보관한다. 마지막 사용 후 4시간이 지나거나 서버 프로세스가 종료되면 제거하며, 실행 중인
작업의 소스는 pin으로 보호한다. 서버 시작 시 소유자, `0700` 권한, mtime과 이전 프로세스
생존 여부를 확인하여 오래된 `sfud-imports-*` 및 레거시 `sfud-uploads-*` 디렉터리만 정리한다.
용량은 사용자당 500 MiB, 서버 전체 2 GiB이며 `SFUD_USER_IMPORT_QUOTA_BYTES`,
`SFUD_SERVER_IMPORT_QUOTA_BYTES`로 조정한다. 한 릴리스 동안 기존 `SFUD_*_UPLOAD_QUOTA_BYTES`도
새 환경변수가 없을 때만 적용한다. 서버 프로젝트는 등록된 경로를 참조하며 Git 프로젝트는 임시 복사본이다.

폴더 업로드 UI와 multipart 처리는 제거했다. 이전 클라이언트의 POST `/api/v1/uploads/projects`와
DELETE `/api/v1/uploads/projects/:id`는 한 릴리스 동안 인증·역할·CSRF 확인 후 본문 파싱 전에
`410 PROJECT_UPLOAD_REMOVED`를 반환한다. 업그레이드 전 진행 중 작업을 끝내고, 필요한 소스는
Git에서 다시 가져온다. 과거 실행 이력의 소유권·준비된 승인 payload·임시 경로 가림 처리는 유지한다.

`SFUD_DATA_DIR` 환경변수로도 저장 위치를 지정할 수 있다. 데이터 디렉터리와 run 디렉터리는
`0700`, DB와 artifact 파일은 `0600` 권한으로 제한한다. 비교 상세와 Salesforce 원문 결과는
gzip artifact로 분리하며 최근 작업 목록은 별도 summary column만 조회한다. 기본 run 보존 기간은
7일, 전체 상한은 5GB, 새 snapshot 시작에 필요한 최소 여유 공간은 512MB다. 각각
`SFUD_RUN_RETENTION_HOURS`, `SFUD_RUN_MAX_BYTES`, `SFUD_RUN_MIN_FREE_BYTES`로 조정할 수 있다.
여러 웹 프로세스가 같은 SQLite DB를 공유할 때 배포 준비 요청은 사용자당 2개, 전체 8개로
제한한다. 준비 lease 기본값은 300초이며 `SFUD_DEPLOYMENT_ADMISSION_LEASE_SECONDS`(30~3600)로
조정한다. 준비가 끝나면 lease를 즉시 해제하고, 프로세스 중단으로 남은 lease는 만료 시 회수한다.
실제 Salesforce 실행은 별도 execution lease로 전역 한 개만 허용한다. 실행 중에는 lease를
heartbeat로 갱신하며, 중단된 프로세스의 lease는 기본 300초 뒤 회수한다.
`SFUD_DEPLOYMENT_EXECUTION_LEASE_SECONDS`(30~3600)로 조정할 수 있다.
웹 작업 실행 기록 정리는 서버 시작 시와 실행 중 1분마다 수행한다. 실행 중·재확인 대기 작업, 승인
유효시간 내 dry-run, 대기·진행 중 배포가 참조하는 원본 payload와 공유 `selected-manifests`
입력 디렉터리, DB가 추적하지 않는 CLI 실행 폴더는 삭제하지 않는다. 따라서 5GB는 정리 목표이며 보호된 자료가 많으면 이를
초과할 수 있다. 보호된 기록만으로 상한을 넘은 동안에는 새 Dry-run·직접 배포 요청을 `503 REQUEST_CAPACITY_EXCEEDED`로
차단하며, 기존 작업을 삭제하거나 중단하지 않는다. 메모리 DB를 사용하는 테스트 서버는 인스턴스마다 별도 임시 파일 저장소를
사용하고 종료 시 해당 저장소만 제거한다.
SQLite에는 다음 설정을 적용한다.

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

최초 관리자가 생성되면 해당 코드는 더 이상 사용할 수 없다. 비밀번호는 `scrypt`로 해시하고 세션·CSRF 토큰은 SHA-256 해시만 SQLite에 저장한다. 세션 쿠키는 `HttpOnly`, `SameSite=Strict`이며 HTTPS reverse proxy에서는 `Secure` 속성도 적용된다. 로그인과 최초 관리자 설정은 실패 횟수를 기준으로 제한한다.

### 웹 실행 모드와 Salesforce 인증

`.env`의 `LOCAL`은 기본값이 `false`다. `LOCAL=true`에서는 최초 설정과 로그인 없이 홈 화면을 열고, 서버를 실행한 OS 계정의 기존 `sf` CLI Org를 사용한다. 주소는 설정값과 관계없이 `127.0.0.1`로 고정하며 공개 Origin과 프록시 설정은 무시한다. 브라우저에서는 `http://127.0.0.1:27546`과 `http://localhost:27546`을 사용할 수 있다. 기본 데이터 디렉터리는 `.sfud-local`이며 기존 사용자 DB와 모드를 바꾸어 사용할 수 없다. 같은 기기의 다른 OS 사용자도 루프백에 접근할 수 있으므로 단독 사용 기기에서만 설정한다.

`LOCAL=true`의 **인증 관리 → Salesforce**에서 별칭과 로그인 주소를 입력하고 **브라우저에서 Salesforce 로그인**을 누르면 Salesforce CLI 기본 OAuth 로그인 페이지가 열린다. 서버에 브라우저가 없어도 로그인 URL은 접속 중인 브라우저에서 열린다. OAuth 응답은 서버의 `localhost:1717`로 돌아오므로 SSH 터널에 UI 포트와 함께 콜백 포트를 전달한다. 프로젝트에 `oauthLocalPort`를 지정했다면 화면에 표시되는 콜백 포트를 사용한다. 별도 External Client App은 필요하지 않다.

```bash
ssh -N -L 27546:127.0.0.1:27546 -L 1717:localhost:1717 user@server
```

```dotenv
LOCAL=true
```

`LOCAL=false`에서는 로그인한 사용자별 Salesforce 연결을 사용한다. 서버의 공용 `sf` 로그인은 웹 작업에 사용하지 않는다. 관리자는 `SFUD_TOKEN_SECRET`에 32~1024자의 임의 문자열을 지정하고 서버를 시작한다. 같은 DB의 연결을 계속 읽으려면 이 값을 유지해야 한다.

```bash
openssl rand -hex 32
```

원격 서버에서 사용자 PC CLI나 SSH 터널 없이 연결하려면 Salesforce OAuth 앱의 Web Server Flow를 설정한다. 앱에 API 및 refresh token 권한을 허용하고, 다음 callback을 앱에 등록한다. 대상 Org의 앱 설치나 사용자 승인 정책이 있다면 해당 Org에서도 허용해야 한다.

```text
https://<SFUD 공개 호스트>/api/v1/salesforce/oauth/callback
```

서버 `.env`에 앱의 Client ID/Secret과 고정 HTTPS origin을 설정한다. 실제 자격 증명은 `.env`에만 두고 저장소나 채팅에 기록하지 않는다. `SFUD_PUBLIC_ORIGIN`은 경로 없는 origin이어야 하며, 로그인 주소는 `login.salesforce.com`, `test.salesforce.com` 또는 Salesforce My Domain HTTPS 주소를 사용할 수 있다.

```dotenv
LOCAL=false
SFUD_PUBLIC_ORIGIN=https://deploy.example.com
SFUD_SF_OAUTH_CLIENT_ID=<Salesforce 앱 Client ID>
SFUD_SF_OAUTH_CLIENT_SECRET=<Salesforce 앱 Client Secret>
SFUD_TOKEN_SECRET=<openssl rand -hex 32로 생성한 키>
```

인증 관리의 **Salesforce 계정 연결**은 OAuth PKCE 승인을 같은 브라우저 탭에서 진행하고 연결을 시작한 사용자 계정에 저장한다. callback은 짧은 수명의 브라우저 확인 쿠키를 검증한 뒤 고정 인증 화면으로 돌아오며, 로그인 세션과 CSRF를 다시 확인한 후 연결을 저장한다. 서버 재시작이나 만료로 진행 중 연결이 끝나면 화면에서 다시 시작한다. 앱 자격 증명과 토큰을 포함한 연결 값은 `SFUD_TOKEN_SECRET`으로 암호화 저장한다.

OAuth 앱을 구성하지 않은 경우에는 **수동 SFDX 인증 URL 등록**을 보조 경로로 사용할 수 있다. 사용자는 Salesforce CLI에서 인증한 다음 자신의 인증 URL을 입력한다.

```bash
sf org login web --alias my-org
sf org auth show-sfdx-auth-url --target-org my-org
```

샌드박스와 My Domain은 `sf org login web`에 적절한 `--instance-url`을 지정한다. 두 번째 명령의 SFDX 인증 URL에는 갱신 토큰이 있으므로 비밀로 취급하고 인증 관리의 일회성 입력란에 붙여 넣는다. 기본 `PlatformCLI` URL처럼 client secret 부분이 빈 형식도 등록할 수 있다. 서버는 Org ID·사용자명·인스턴스 URL을 확인하고 사용자 소유로 암호화 저장한다. 자격 증명은 작업별 임시 CLI 저장소에 복원했다가 삭제한다. 공개 주소에서는 HTTPS가 필요하다. 연결 해제 후 Salesforce 측 토큰 폐기는 Org에서 별도로 관리한다. Org가 high assurance 인증을 강제하면 SFDX URL의 비대화형 재사용이 제한될 수 있으므로 Org 정책을 확인한다.

`LOCAL=false`의 실제 배포는 **사용자 관리 → 대상 Org 실행 권한**에서 실제 Salesforce Org ID로 정책을 등록해야 한다. 정책이 없는 Org는 관리자도 배포할 수 없다. 기존 별칭 기반 권한은 자동 승격되지 않으며 화면에 검토 대상으로 표시된다.

`ADMIN` 계정에는 **사용자 관리** 메뉴가 표시된다. 이 화면에서 초기 비밀번호와 함께 사용자를
생성하고 `VIEWER`, `OPERATOR`, `DEPLOYER`, `ADMIN` 역할을 지정하거나 계정을 비활성화·재활성화할
수 있다. 비활성화 시 기존 세션도 즉시 폐기된다. 자기 역할 변경, 자기 계정 비활성화와 마지막
활성 `ADMIN` 제거는 서버에서 차단하며 생성·역할 변경·활성 상태 변경은 모두 감사 로그에 남긴다.
사용자 목록과 변경 API인 `/api/v1/admin/users`도 `ADMIN` 세션 및 상태 변경 시 CSRF 검증을 요구한다.

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

reverse proxy 헤더는 proxy 주소를 명시적으로 신뢰한 경우에만 사용한다. 외부 HTTPS origin도 함께
고정해야 scheme과 host를 모두 검증할 수 있다.

```bash
node dist/cli.js ui \
  --host 127.0.0.1 \
  --trusted-proxy 127.0.0.1 \
  --public-origin https://deploy.example.com \
  --no-open
```

여러 proxy는 `--trusted-proxy`를 반복하거나 `SFUD_TRUSTED_PROXIES`에 쉼표로 구분해 지정한다.
`--public-origin`은 `SFUD_PUBLIC_ORIGIN`으로도 지정할 수 있다. 공개 `/api/v1/health`는 서비스 상태와
버전만 반환하고, 저장소·queue·bind 정보는 로그인한 사용자의 `/api/v1/diagnostics`에서만 제공한다.

인증된 사용자만 배포 작업 이력 API에 접근할 수 있고, 로그아웃을 포함한 상태 변경 요청은 동일 출처와 CSRF 토큰을 모두 검증한다. OIDC는 셀프 호스팅 로컬 계정과 병행할 수 있는 후속 인증 공급자로 추가한다.

### 웹 비교 및 dry-run

`OPERATOR`, `DEPLOYER`, `ADMIN` 사용자는 웹의 **비교 및 배포** 화면에서 desired source와
target org를 선택하고, 비교가 성공하면 같은 범위로 Salesforce check-only를 실행할 수 있다.
desired source는 `--project`로 등록한 서버 프로젝트, Git에서 가져온
프로젝트, 또는 다른 Salesforce org 중에서 선택한다.

비교 결과의 체크박스로 metadata 컴포넌트를 **배포 대상**으로 선택할 수 있다. metadata type을
바꿔 검색해도 같은 desired source와 target org를 사용하는 동안 선택 목록은 유지된다.
체크를 해제하거나 배포 대상의 제거 버튼을 누르면 목록에서 빠진다. target에만 존재하는
`TARGET ONLY` 항목은 desired source에 payload가 없으므로 선택할 수 없다.

배포 대상에 `ApexClass`가 포함되면 **Apex 테스트 클래스** 선택기가 열린다. 서버·Git DX
프로젝트는 package directory에서, org 소스는 Tooling API에서 활성 Apex Class를 조회해
접미사와 무관하게 모든 클래스 후보를 표시한다. 이름으로 후보를 검색하고 여러 개 체크하거나
클래스명을 직접 입력할 수 있으며, 선택 값은 `auto` 또는 `RunSpecifiedTests`와 함께 Dry-run에 전달된다.
`RunSpecifiedTests`는 테스트 클래스가 하나 이상 선택되기 전까지 Dry-run을 시작할 수 없다.

배포 대상의 **Dry-run**과 **실제 배포** 버튼은 처음부터 함께 표시된다. Dry-run은 선택한
컴포넌트만 포함한 전용 `package.xml`을 만들고 Salesforce check-only를 실행하며, 성공하면 staging
payload와 SHA-256을 고정한다. 성공한 Dry-run 뒤 실제 배포하면 서버가 동일 payload SHA-256을
다시 확인한다.

Dry-run 없이 바로 실제 배포할 수도 있다. 이 경우에도 화면에서 선택한 테스트 수준을 check-only와
실제 배포에 동일하게 적용한다. `auto`는 명시 테스트, staging의 접미사 테스트, `RunLocalTests`
fallback 순서로 결정한다. 테스트 클래스를 명시했다면 `RunSpecifiedTests` check-only 응답에 보고된
각 Apex 클래스·트리거의 라인 커버리지가 모두 75% 이상일 때만 실제 배포한다. `NoTestRun`을
명시적으로 선택한 경우에만 check-only를 생략한다. 프로덕션 org처럼 `NoTestRun`을 허용하지 않는
대상은 Salesforce가 거부하며 실패 상태로 기록된다.
`DEPLOYER` 또는 `ADMIN` 사용자가 대상 org 별칭과 `실제 배포` 확인 문구를 정확히 입력해야 실제
배포 버튼이 활성화된다.

ADMIN은 **사용자와 배포 권한** 화면에서 대상 org 별칭별 실제 배포 allowlist를 관리할 수 있다.
특정 org에 처음 실행 권한을 추가하면 allowlist가 활성화되며, 그 뒤에는 활성 ADMIN 또는 명시적으로
권한을 받은 활성 DEPLOYER만 해당 org에 실제 배포할 수 있다. 권한을 모두 회수해도 allowlist는
유지되므로, 다시 열기 전까지는 ADMIN만 실행할 수 있다. 기존 설치의 org는 첫 권한 설정 전까지
기존 역할 기반 정책을 유지한다.

직접 배포 API는 8~200자의 `Idempotency-Key` 헤더를 요구한다. 같은 사용자가 같은 key와 같은
요청을 재전송하면 기존 job을 반환하고, 같은 key를 다른 요청에 재사용하면
`409 IDEMPOTENCY_CONFLICT`로 거부한다. 웹 UI는 한 배포 결과가 확정될 때까지 같은 UUID를
재사용한다. HTTP 연결 중단은 이미 Salesforce에 제출된 작업의 취소를 뜻하지 않는다.

dry-run과 직접 배포 job은 Salesforce CLI가 확인한 source·target의 username, org ID, instance URL
지문을 함께 저장한다. Salesforce 제출 직전에 alias를 다시 조회해 identity가 달라졌으면 제출을
차단하며, 성공한 dry-run의 승인 유효시간은 30분이다. UI에는 target alias, username, 마스킹한 org
ID를 함께 표시한다. 서버는 토큰·client ID·키 경로·로컬 절대 경로와 전체 org ID를 API에 반환하지
않는다.

`SFUD_QUICK_DEPLOY_ENABLED=false`로 새 Quick Deploy 제출만 즉시 차단할 수 있다. 이 경우
일반 배포로 자동 재제출하지 않으며, 이미 Salesforce에 제출한 attempt의 조회·재확인은 계속 가능하다.

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

Salesforce 성공 후 마지막 완료 상태 저장이 실패하면 원격 결과와 배포 ID를 보존하고
`RECONCILE_REQUIRED` 전환을 시도한다. 이후 1초마다 DB 저장만 재시도하며 Salesforce 작업을
재제출하지 않는다. DB 전체 장애 중에는 확인된 결과를 메모리에 유지하고, 저장이 복구되기
전까지 정상 종료 시 DB를 닫지 않는다. 저장 지연으로 dry-run 승인 유효시간이 늘어나지는 않는다.

## Git 프로젝트 가져오기

Git DX 프로젝트의 `classes/interface/Foo.cls` 같은 하위 폴더 Apex는 작업용 복사본에서
`classes/Foo.cls`로 펼친 뒤 비교·배포에 사용한다. `.cls-meta.xml`도 함께 펼치며 원본 Git 경로와
파일 내용은 변경하지 않는다. 여러 package/폴더의 같은 클래스명(대소문자 차이 포함)은
덮어쓰지 않고 `APEX_PATH_COLLISION`으로 거절한다. `.forceignore`로 제외한 경로는 펼치지 않으며,
LWC 번들·보고서 폴더 등 다른 메타데이터의 구조는 유지한다. 기존 가져오기에는 재가져오기/동기화가 필요하다.

비교 결과의 NEW / TARGET ONLY / MODIFIED / IDENTICAL 버튼은 해당 상태만 표시한다.
메타데이터 검색은 이름·타입·파일 경로를 대소문자 구분 없이 찾으며 상태 필터와 함께 적용된다.
필터 변경 시 첫 페이지로 이동하지만 배포 선택은 유지한다. IDENTICAL은 필요할 때 저장된 비교 결과에서
불러오며 Git/Salesforce를 다시 조회하지 않는다. 전체/필터 초기화로 목록을 되돌릴 수 있다.

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

## 개발 명령

| 명령 | 설명 |
|---|---|
| `npm run dev -- <args>` | TypeScript 소스에서 CLI 실행 |
| `npm run typecheck` | CLI와 E2E TypeScript 검사 |
| `npm run lint` | JavaScript 설정·스크립트 ESLint 검사 |
| `npm run dead-code` | Knip 미사용 파일·export 검사 |
| `npm run quality` | lint와 미사용 코드 검사 |
| `npm test` | Vitest 단위·fixture 테스트 |
| `npm run test:e2e` | Playwright HTML 리포트 테스트 |
| `npm run test:platform` | process·path·관리 저장소·Git 수신·암호화 SQLite 플랫폼 스모크 |
| `npm run build` | `dist/` 빌드 |
| `npm run check` | 타입, 품질, Vitest, 빌드 검사 |
| `npm run package:smoke` | tarball 생성·설치, dependency tree와 CLI 실행 검증 |
| `npm run verify` | `check`와 Playwright 전체 검증 |

## CI와 릴리스 산출물

Pull Request와 공유 브랜치는 Linux Node.js 24의 전체 단위·브라우저·패키지 검증, Linux
Node.js 22.19.0의 최소 지원 버전 검증, Windows Node.js 24의 플랫폼 스모크를
통과해야 한다. TypeScript의 미사용 선언 검사와 Knip의 미사용 export·파일 검사도 `check`에
포함된다.

태그 릴리스는 npm 11.20.0으로 `npm-shrinkwrap.json`이 포함된 tarball을 만든 뒤, 그 tarball을
새 prefix에 설치해 전체 dependency tree와 `sfud --version`을 검증한다. GitHub Release에는
tarball, SHA-256 체크섬과 CycloneDX JSON SBOM을 각각 첨부한다. SBOM은 공급망 구성의 가시성을
위한 별도 산출물이며, 설치 재현성은 `npm-shrinkwrap.json`과 tarball 설치 검증으로 확보한다.

## 브랜치 승격 규칙

기능은 다음 순서로 승격한다.

```text
feat/* 또는 fix/* → canary → main
```

- 기능 브랜치에서 구현과 fixture 검증
- `canary` 병합 후 전체 검증
- `main` 병합 전 canary 결과 재확인
- 기능 단위로 커밋하고 작은 중간 커밋을 남발하지 않음

RC는 `canary`에서 GitHub prerelease와 npm `next`로 공개한다. RC 검증 후 정식 버전으로 변경하고 `canary → main` PR을 병합한 다음 정식 태그를 생성한다. 브랜치 병합만으로 패키지를 발행하지 않는다.

GitHub Release의 설치 검증이 완료되면 `publish-npm.yml`을 해당 태그 ref로 수동 실행한다. npm은 정식 버전도 우선 `next`에 발행하고, registry 산출물 검증 후 소유자가 `latest`로 별도 승격한다. 원본 Release와 동일한 태그·커밋·파일의 발행 재시도는 허용하며, 해당 커밋이 RC는 `canary`, 정식은 `main` 이력에 있어야 한다.

## 현재 검증 범위

- TypeScript 타입 검사
- Vitest 단위·fixture 테스트
- mock `sf` 기반 org ↔ org 비교와 배포 안전장치
- 실제 Salesforce CLI 기반 local ↔ local source 변환·비교
- Playwright Chromium 기반 데스크톱·모바일 HTML 렌더링

실제 org 전체 범위 검증은 배포 대상과 manifest를 명시적으로 정한 뒤 수행한다. 저장소 검증에서는 작은 단일 컴포넌트 check-only만 실행한다.

인증 관리에서 Git·Salesforce 연결 이름 또는 행을 클릭하면 연결 설정을 열 수 있다. 별칭, Git 연결 대상과 새 토큰, Salesforce 로그인 대상과 재인증을 변경할 수 있다. 계정 범위 Git 연결은 저장 직후 저장소 목록을 열며, 연결 설정의 **저장소 목록 조회**로 다시 조회한다. 저장소를 선택하고 브랜치를 확인해 가져오거나 배포 브랜치로 등록한다. 목록 권한 오류는 이 화면에 표시된다. 새 인증 검증 실패나 동시 변경 충돌 시 기존 연결을 덮어쓰지 않는다.

Salesforce CLI 인증 목록은 최초 앱 조회에서 한 번 불러온 뒤 서버가 실행 중인 동안 같은 사용자의 탭 이동·브라우저 새로고침·재로그인에서 재사용한다. 서버를 재시작하면 최초 조회를 다시 수행한다. 연결 추가·이름 변경·재인증·삭제와 인증 관리의 **새로고침**에서 갱신하며, CLI를 외부에서 변경했을 때는 새로고침을 사용한다. 사용자별 목록은 분리하고, 캐시에는 공개 Org 정보만 보관한다. 배포 직전 Org 확인과 실제 작업의 인증 복원은 계속 수행한다.
