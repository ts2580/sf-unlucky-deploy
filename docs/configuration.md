# 설치와 설정 상세

[README로 돌아가기](../README.md)

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

### npm 패키지 설치

npm 패키지 이름은 `@trstyq/sf-unlucky-deploy`이고 실행 명령은 `sfud`입니다. 정식 일반판은 `latest`, 시험판 일반판은 `next` 채널로 설치하며 프로젝트 라이선스는 MIT입니다. 특정 버전을 고정하려면 `@latest` 대신 `@0.4.0`처럼 발행된 버전 번호를 지정하세요.

```bash
npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@latest
sfud --version
sfud --help
```

Windows x64에서는 SQLite native binding과 실행 의존성을 포함한 `win32-x64` 채널도 사용할 수 있습니다.

```powershell
npm install --global --ignore-scripts @trstyq/sf-unlucky-deploy@win32-x64
sfud --version
```

일반판과 같은 패키지 이름·실행 명령을 사용하므로 기존 전역 설치를 대체합니다. 같은 설치 명령을 다시 실행하면 해당 채널의 버전으로 갱신됩니다. Windows 번들 버전은 정식 `0.4.0-win32-x64.1`, 시험판 `0.4.0-rc.4.win32-x64.1`처럼 원본 버전·플랫폼·번들 차수로 구분하고, `sfud --version`은 원본 앱 버전(정식 번들의 경우 `0.4.0`)을 표시합니다. Windows ARM64용이 아니며, Git과 Salesforce CLI는 별도로 설치해야 합니다.

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

비밀값은 `config.json`에 넣지 마세요. `~/.sfud/secrets.env`는 첫 실행과 `config init`에서 사용자 전용 권한으로 자동 생성합니다. 기존 config.json만 있는 경우에도 누락된 secrets.env를 만들며, 기존 비밀값 파일은 덮어쓰지 않습니다. 자동 생성 내용은 항목 안내 주석뿐이고 비밀값을 생성하거나 빈 환경변수를 활성화하지 않습니다. 사용할 항목의 주석을 풀고 실제 값을 넣으세요. `secrets.env`에는 `SFUD_TOKEN_SECRET`, `SFUD_SF_OAUTH_CLIENT_ID`, `SFUD_SF_OAUTH_CLIENT_SECRET`을 사용합니다. 이전 두 개별 암호화 키 이름도 호환용으로 허용합니다. POSIX에서는 새 파일을 `umask 077` 상태에서 만들고 `chmod 600 ~/.sfud/secrets.env`인지 확인한 뒤 편집하세요. 기존 설정의 권한이 안전하지 않으면 `sfud`가 읽기를 거부하므로 권한을 직접 점검하세요. UI 호스트를 루프백 밖으로 설정해도 원격 bind에는 계속 `--allow-remote`가 필요하며 비밀번호 없는 `LOCAL=true`는 루프백에서만 사용할 수 있습니다. 원격 개인용은 `SFUD_ACCESS_PASSWORD`를 설정하세요.

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

npm 대신 GitHub Release의 `.tgz`와 `SHA256SUMS`를 내려받아 설치할 수도 있다. 아래는 `v0.3.0` 파일명 예시이며, 실제 내려받은 릴리스의 파일명을 사용한다.

```bash
sha256sum --check SHA256SUMS
npm install --global --allow-scripts=sqlite3 ./sf-unlucky-deploy-0.3.0.tgz
sfud --version
```

`sqlite3` native binding과 `esbuild`의 설치 스크립트만 명시적으로 허용한다. npm 12에서는 lockfile의 resolved identity를 사용할 수 없는 경우가 있으므로 `allowScripts` 키는 버전을 붙이지 않은 패키지 이름으로 유지한다. Release는 `package.json`과 같은 버전의 annotated tag로 발행한다. RC 태그(`vX.Y.Z-rc.N`)는 최신 `canary`, 정식 태그(`vX.Y.Z`)는 최신 `main` 커밋을 정확히 가리켜야 한다.

아래 예시의 `sfud`는 빌드된 CLI를 뜻한다. 개발 중에는 `sfud` 대신 `npm run dev --`를 앞에 사용하면 된다.


### 대화형 개인용 설정과 읽기 전용 점검

`sfud setup`은 서버 터미널에서 내 PC 전용 또는 비밀번호로 보호하는 원격 개인용 설정을 저장합니다. 기존 설정·비밀값을 읽은 뒤 저장할 파일·적용 모드·주소를 비밀값 없이 확인합니다. 비밀번호 입력은 숨기며 재입력으로 일치를 확인합니다. 비대화형 실행은 파일을 만들지 않고 안내와 코드 2로 종료합니다. 기존 사용자별 서버 설정과 DB를 개인용으로 전환하지 않습니다.

설정 우선순위는 UI CLI 옵션 → 프로세스 환경변수(빈 값 포함) → 홈 설정 → 기본값입니다. 시작 스크립트에서 전달하는 CLI 옵션은 setup/doctor가 자동으로 확인할 수 없습니다. 홈 설정의 상대 데이터·키 파일 경로는 홈 설정 디렉터리 기준이고, 직접 전달한 환경변수·CLI 상대경로는 실행 디렉터리 기준입니다. 원격 주소를 저장해도 시작할 때 `sfud ui --allow-remote --no-open`을 사용합니다.

기존 `SFUD_TOKEN_SECRET`·호환 키·Git 키 파일을 자동 교체하지 않습니다. 키 생성은 새 빈 데이터 경로에서만 선택할 수 있습니다. 기존 DB에 키가 없다면 기존 키를 복구해야 합니다. DB에 미체크포인트 WAL이 있으면 모드를 확정하지 않고 서버 종료 후 점검하거나 별도 경로를 사용하도록 안내합니다. 설정 저장은 사용자 전용 임시 파일을 검증한 뒤 두 파일을 교체하며 실패하면 이번 작업이 교체한 파일만 복구합니다. 다른 프로세스가 파일을 바꾸거나 `.setup.lock`이 있으면 저장을 중단합니다. 비정상 종료로 잠금이 남았다면 진행 중인 setup이 없는지 확인한 뒤 잠금을 직접 정리하세요. 두 파일 교체 사이의 프로세스 강제 종료·전원 장애에는 자동 복구를 보장하지 않습니다.

기존 secrets.env 줄은 그대로 보존하고 변경된 값만 마지막에 추가합니다. Node dotenv 파서로 저장 결과가 원래 값과 일치하는지 확인합니다. 따옴표 세 종류와 `#`를 함께 포함하는 등 dotenv로 표현할 수 없는 새 값은 저장 전에 거부합니다. POSIX 700/600과 Windows 현재 사용자 SID만 허용하는 ACL 검사, 링크·파일 교체 검사를 유지합니다.

`sfud doctor --json`은 도구 버전, 적용 파일·모드·주소·프록시, 비밀값 존재·형식·권한, 데이터 경로 접근 상태, 기존 DB 모드와 OAuth 콜백을 읽기 전용으로 점검합니다. 데이터 접근 검사는 실제 쓰기 테스트가 아닙니다. DB는 immutable 읽기로 검사하므로 WAL/shm을 만들지 않습니다. 경고만 있으면 0, 점검 실패는 1, 명령 사용·실행 오류는 2로 종료합니다. 비밀값과 도구 오류 원문은 출력하지 않습니다.

`sfud doctor --check-url`은 계산한 URL에 서버에서 HEAD 요청만 보냅니다. 프록시 뒤 외부 브라우저의 접근 성공은 추정하지 않습니다. 개인용 OAuth 콜백은 공개 UI URL과 별개로 서버의 로컬 포트(기본 1717, 현재 DX 프로젝트의 oauthLocalPort 우선)입니다. 원격 개인용에서 새 브라우저 인증을 추가할 때 브라우저 PC와 서버 사이의 해당 포트 SSH 터널을 확인하세요. 사용자별 모드의 브라우저 OAuth 콜백은 HTTPS 공개 Origin의 `/api/v1/salesforce/oauth/callback`입니다.
