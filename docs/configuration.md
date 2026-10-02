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

비밀값은 `config.json`에 넣지 마세요. `~/.sfud/secrets.env`는 첫 실행과 `config init`에서 사용자 전용 권한으로 자동 생성합니다. 기존 config.json만 있는 경우에도 누락된 secrets.env를 만들며, 기존 비밀값 파일은 덮어쓰지 않습니다. 자동 생성 내용은 항목 안내 주석뿐이고 비밀값을 생성하거나 빈 환경변수를 활성화하지 않습니다. 사용할 항목의 주석을 풀고 실제 값을 넣으세요. `secrets.env`에는 `SFUD_TOKEN_SECRET`, `SFUD_SF_OAUTH_CLIENT_ID`, `SFUD_SF_OAUTH_CLIENT_SECRET`을 사용합니다. 이전 두 개별 암호화 키 이름도 호환용으로 허용합니다. POSIX에서는 새 파일을 `umask 077` 상태에서 만들고 `chmod 600 ~/.sfud/secrets.env`인지 확인한 뒤 편집하세요. 기존 설정의 권한이 안전하지 않으면 `sfud`가 읽기를 거부하므로 권한을 직접 점검하세요. UI 호스트를 루프백 밖으로 설정해도 원격 bind에는 계속 `--allow-remote`가 필요하며 `LOCAL=true`는 루프백으로 고정됩니다.

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
