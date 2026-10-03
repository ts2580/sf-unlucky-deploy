# 웹 UI와 서버 운영

[README로 돌아가기](../README.md)

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
`LOCAL=true`는 개인용이며 서버 OS 계정의 Salesforce CLI 인증을 사용한다. 접속 주소와 개인용 여부는 독립적이다.
기본 루프백 주소에서는 로그인 없이 사용한다. 원격 주소·프록시·공개 Origin을 사용하려면
`SFUD_ACCESS_PASSWORD`(12~128자)를 설정해야 하며, 원격 바인딩에는 `--allow-remote`도 필요하다.
설정한 주소를 루프백으로 덮어쓰지 않으며 비밀번호가 없거나 잘못되면 시작을 중단한다.

### 원격 개인용

설정 폴더(`sfud config path`)의 `secrets.env`에 다음 항목을 실제 비밀번호로 설정한다.
기존 파일은 자동 갱신하지 않으므로 항목이 없으면 직접 추가한다.

```dotenv
SFUD_ACCESS_PASSWORD="여기에-12자-이상의-접속-비밀번호"
```

```bash
LOCAL=true sfud ui --host 0.0.0.0 --allow-remote --no-open
```

브라우저에서 `http://서버주소:27546`에 접속한다. 계정 등록 없이 비밀번호만 입력하며,
사용자 관리 없이 기존 개인용 Org·Git 연결·실행 기록을 사용한다. `LOCAL=false`용 DB는 함께 쓰지 않는다.
`./start-local.sh`를 쓰면 프로젝트 `.env`에 `LOCAL=true`, `SFUD_UI_HOST`, `SFUD_ACCESS_PASSWORD`를 설정할 수도 있다.
비밀번호가 설정된 동안은 루프백으로 접속해도 인증을 요구한다.

비밀번호 원문은 DB에 저장하지 않는다. 비밀번호 설정·교체·제거 후 재시작하면 기존 세션을 폐기한다.
같은 비밀번호로 재시작하면 아직 만료되지 않은 세션은 유지한다. 보호 설정이 서로 다른 서버를 같은 데이터 디렉터리로 동시에 실행하지 않는다.

인터넷 공개 시 HTTPS 프록시 뒤에서 사용한다. 예를 들어 프록시가 같은 서버에 있으면
`LOCAL=true`, `SFUD_UI_HOST=127.0.0.1`, `SFUD_PUBLIC_ORIGIN=https://deploy.example.com`,
`SFUD_TRUSTED_PROXIES=127.0.0.1`과 접속 비밀번호를 설정한다. 신뢰할 프록시 주소만 등록한다.

Salesforce **새 연결**의 CLI OAuth는 콜백 포트를 브라우저 PC로 전달해야 한다.
화면에 표시되는 콜백 포트가 기본값 1717이면 PC에서 다음 터널을 연 후 연결한다.

```bash
ssh -N -L 1717:localhost:1717 계정@서버주소
```

이미 서버의 `sf` CLI에 인증된 Org를 사용할 때는 이 콜백 터널이 필요 없다.

### 실행 환경

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

`.env`의 `LOCAL`은 기본값이 `false`다. `LOCAL=true`는 서버를 실행한 OS 계정의 기존 `sf` CLI Org를 사용하는 개인용이다. 접속 비밀번호가 없으면 루프백에서 최초 설정과 로그인 없이 홈 화면을 연다. 브라우저에서는 `http://127.0.0.1:27546`과 `http://localhost:27546`을 사용할 수 있다. 원격 주소·공개 Origin·프록시를 사용하려면 위의 **원격 개인용** 안내에 따라 `SFUD_ACCESS_PASSWORD`를 설정한다. 기본 데이터 디렉터리는 `.sfud-local`이며 기존 사용자 DB와 모드를 바꾸어 사용할 수 없다. 같은 기기의 다른 OS 사용자도 루프백에 접근할 수 있으므로 비밀번호 없는 개인용은 단독 사용 기기에서만 사용한다.

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

## 연결 관리와 인증 목록

인증 관리에서 Git·Salesforce 연결 이름 또는 행을 클릭하면 연결 설정을 열 수 있다. 별칭, Git 연결 대상과 새 토큰, Salesforce 로그인 대상과 재인증을 변경할 수 있다. 계정 범위 Git 연결은 저장 직후 저장소 목록을 열며, 연결 설정의 **저장소 목록 조회**로 다시 조회한다. 저장소를 선택하고 브랜치를 확인해 가져오거나 배포 브랜치로 등록한다. 목록 권한 오류는 이 화면에 표시된다. 새 인증 검증 실패나 동시 변경 충돌 시 기존 연결을 덮어쓰지 않는다.

Salesforce CLI 인증 목록은 최초 앱 조회에서 한 번 불러온 뒤 서버가 실행 중인 동안 같은 사용자의 탭 이동·브라우저 새로고침·재로그인에서 재사용한다. 서버를 재시작하면 최초 조회를 다시 수행한다. 연결 추가·이름 변경·재인증·삭제와 인증 관리의 **새로고침**에서 갱신하며, CLI를 외부에서 변경했을 때는 새로고침을 사용한다. 사용자별 목록은 분리하고, 캐시에는 공개 Org 정보만 보관한다. 배포 직전 Org 확인과 실제 작업의 인증 복원은 계속 수행한다.

## Git 프로젝트 선택과 작업 이어보기

Git 프로젝트를 가져올 때 프로젝트 경로를 입력하지 않으면 저장소 루트와 하위 폴더의 DX 프로젝트를 탐색한다. 후보가 하나이면 그 경로를 사용하고, 여러 개이면 목록에서 선택한다. 배포 브랜치 등록도 확인한 프로젝트 경로를 저장한다. 브랜치를 바꾸면 이전 후보 선택을 다시 확인해야 하며, 등록 후 해당 경로가 사라지면 다른 프로젝트로 자동 전환하지 않는다.

연결 별칭은 표시 이름이다. 계정 연결의 별칭 옆에는 저장소 경로가 함께 표시되고, 비교 소스 선택 목록에는 실제 호스트·저장소·프로젝트 경로가 표시된다. 별칭이 같아도 이 정보를 확인해 소스를 선택한다.

비교 및 배포 화면에서 자주 사용하는 소스·대상·범위·테스트 설정을 이름으로 저장하고 불러올 수 있다. 저장 설정과 탭별 초안은 다시 사용할 선택 정보를 보존하며, 이전 컴포넌트 체크 목록·dry-run 승인·검증 payload를 새 작업에 재사용하지 않는다. 불러온 연결과 대상 Org를 현재 상태에서 다시 확인하고, 메타데이터를 다시 조회해 배포할 항목을 선택한다. 설정을 불러오는 것만으로 비교나 배포가 제출되지 않는다.

실행 기록의 작업 상세에서 진행 상태를 이어서 조회할 수 있다. 새로고침이나 재접속은 작업을 다시 제출하지 않는다. 작업 응답을 받기 전에 연결이 끊겼다면 대기 요청에서 먼저 결과를 조회한다. 아직 작업 생성 여부를 확인하지 못한 요청을 재시도할 때는 원래 idempotency key와 요청 내용을 유지하며, 다른 대상으로 새 요청을 자동 제출하지 않는다. `RECONCILE_REQUIRED`는 원래 작업의 Salesforce 상태 확인으로 해결한다.

실제 배포 버튼을 누르면 Source·Target·반영 항목·테스트·마지막 검증 내용을 최종 요약에서 확인한다. Git 소스는 실제 저장소·커밋·프로젝트 경로를, Org는 사용자명·마스킹한 ID와 확인된 환경을 표시한다. 환경을 확인하지 못하면 **환경 확인 필요**로 표시한다. 요약의 확인 체크 후 최종 배포 버튼을 눌러 제출한다. 선택이 바뀌면 다시 확인해야 하며 기존 승인·Org identity·payload 검사는 계속 적용된다.

오류 해결 안내는 확인된 오류와 다음 조치를 나누어 표시한다. 인증 또는 Org identity 오류는 인증 관리로, Git 프로젝트 경로 오류는 설정으로 이동해 확인한다. 설정에서 돌아오면 보존된 선택을 현재 연결과 다시 대조한 뒤 작업을 계속한다. 정제된 상세 오류 복사에는 인증정보와 민감한 서버 경로를 포함하지 않는다. 컴포넌트 오류만으로 의존성 누락을 확정하거나 배포 항목을 자동 추가하지 않는다.

선택 초안은 사용자·탭별로 최대 20개, 24시간 동안 보존한다. 서버 저장 응답 전의 선택은 브라우저에도 임시 보관하며, 자동 저장이 끝나기 전에 새로고침해도 명시적으로 복원할 수 있다. 이 임시 보관에만 남은 Git 소스가 먼저 만료되었다면 해당 소스를 다시 준비해야 한다. 서버에 저장을 마친 초안과 저장 설정은 저장소·ref·프로젝트 경로를 다시 확인해 복원한다. 어느 경우에도 복원만으로 실제 배포를 제출하지 않는다.
