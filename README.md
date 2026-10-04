# sf-unlucky-deploy

**Salesforce 메타데이터도 변경 이력을 관리하고, 차이를 확인한 뒤 반영할 수 있어야 한다.**

이 프로젝트는 Git에 쌓인 메타데이터 이력과 로컬 Salesforce DX 프로젝트 사이의 차이를 더 쉽게 확인하기 위해 만들었다. Git으로 버전을 관리하더라도 저장소의 특정 브랜치와 로컬 작업 내용, 실제 Org의 상태를 메타데이터 단위로 맞춰 비교하는 일은 번거롭다.

sf-unlucky-deploy는 Git·로컬 프로젝트·Salesforce Org의 메타데이터를 같은 기준으로 비교하고, 어떤 항목이 추가되거나 바뀌었는지와 실제 내용 차이를 보여준다. 비교한 변경을 Org에 반영해야 할 때는 필요한 항목을 골라 검증하고 배포하는 흐름까지 이어갈 수 있다.

## 아이디어의 출발점

이 프로젝트의 아이디어는 Aladin 프로젝트의 [classDeploy Lightning Web Component](https://github.com/ts2580/Aladin/tree/main/force-app/main/default/lwc/classDeploy)에서 시작했다. Salesforce 클래스 배포 경험을 Git·로컬 프로젝트·Org 전반의 메타데이터 비교와 검증·배포 흐름으로 확장한다.

## 설치하고 실행하기

Node.js **22.19.0 이상**, npm, Salesforce CLI v2(`sf`), Git이 필요하다.

```bash
npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@latest
sfud config init
sfud ui --project "/path/to/salesforce-project"
```

Windows x64에서는 SQLite 바이너리를 포함한 번들을 설치할 수 있다.

```powershell
npm install --global --ignore-scripts @trstyq/sf-unlucky-deploy@win32-x64
```

정식 일반판은 `latest`, 시험판 일반판은 `next`, Windows 번들은 `win32-x64` 채널을 사용한다. 같은 설치 명령을 다시 실행하면 해당 채널의 버전으로 갱신된다.

`--project`에는 `sfdx-project.json`이 있는 로컬 Salesforce DX 프로젝트 경로를 넣는다. 여러 프로젝트는 옵션을 반복해서 등록하고, Git과 Org만 사용할 때는 생략한다.

처음 설치한 환경에서 `config init`은 개인용 `LOCAL=true` 설정을 만든다. 브라우저에서 **http://127.0.0.1:27546**을 열면 별도 SFUD 로그인 없이 사용할 수 있다. 기존 설정이 있으면 덮어쓰지 않으므로 `sfud config path`로 위치를 확인하고 `env.LOCAL`을 `"true"`로 설정한다.

Org도 비교하려면 UI를 실행한 OS 계정에서 미리 로그인하거나 **인증 관리 → Salesforce**에서 연결한다.

```bash
sf org login web --alias dev
sf org login web --alias prod
```

팀 서버에서 여러 사용자가 접속할 경우에는 [웹 UI와 서버 운영](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md)의 `LOCAL=false` 설정을 따른다.

### 원격 리눅스에서 혼자 사용하기

`LOCAL=true`는 개인용 설정이다. 원격 서버에서도 서버 OS 계정의 Salesforce CLI 인증을 그대로 사용할 수 있다.
`sfud config path`에 표시되는 설정 폴더의 `secrets.env`에 `SFUD_ACCESS_PASSWORD`를 12~128자로 설정한다.
비밀번호는 `config.json`이나 명령줄 인자에 넣지 않는다.

```bash
LOCAL=true sfud ui --host 0.0.0.0 --allow-remote --no-open
```

PC 브라우저에서 `http://서버주소:27546`을 열고 접속 비밀번호만 입력한다. 앱 계정 생성이나 사용자 관리는 필요 없다.
비밀번호 없이 원격 주소로 시작하면 오류로 중단한다. 같은 PC에서 사용하는 기존 개인용은 로그인 없이 그대로 동작한다.
인터넷에 공개할 때는 [HTTPS 프록시 설정](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md)을 사용한다.
Salesforce **새 연결**의 브라우저 OAuth 콜백은 별도 SSH 포트 전달이 필요하다. 이미 서버 CLI에 로그인한 Org는 바로 사용한다.

## Git과 로컬 프로젝트 비교하기

### 1. Git 저장소 연결

Git 토큰을 저장하려면 먼저 `sfud config path`에 표시되는 설정 파일과 같은 디렉터리의 `secrets.env`에 `SFUD_TOKEN_SECRET`을 설정한다. 아래 명령으로 임의 문자열을 만들고, 결과를 `SFUD_TOKEN_SECRET=<생성한 값>` 형태로 저장한 뒤 UI를 재시작한다. 기존 키가 있다면 그대로 사용한다.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

**인증 관리 → Git**에서 **저장소 하나 연결**을 선택하고 제공자, 저장소 Git URL, 읽기 권한이 있는 PAT/API Token을 입력한다. GitHub·GitLab·Bitbucket을 지원한다. 제공자별 토큰 설정과 공개 저장소 가져오기는 [Git 연결 안내](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md)를 참고한다.

### 2. 비교 대상과 범위 선택

1. **비교 및 배포** 화면의 **DESIRED SOURCE**에서 등록한 로컬 프로젝트를 선택한다.
2. **TARGET**에서 연결한 Git 저장소를 선택한다.
3. Git 브랜치와 메타데이터 타입(예: `ApexClass`, `CustomField`)을 선택하고 가져온다. 저장소에 DX 프로젝트가 여러 개면 프로젝트 루트도 선택한다.
4. **현재 타입 비교 실행**을 켠 상태에서 **메타데이터 비교**를 누른다. 끄면 버튼이 **메타데이터 다운로드**로 바뀌고 Source만 가져온다.

같은 방식으로 Git ↔ Git, Git ↔ Org, 로컬 ↔ Org, Org ↔ Org도 비교할 수 있다. 양쪽에 Git을 선택했다면 같은 메타데이터 타입을 가져온다.

### 3. 변경 내용 확인

결과에서 컴포넌트를 열어 XML 값이나 Apex·LWC 파일의 diff를 확인한다. 이름·타입·파일 경로로 검색하거나 상태별로 필터링할 수 있다.

| 화면 상태 | 의미 |
|---|---|
| `NEW` | Source에만 있는 항목 |
| `TARGET ONLY` | Target에만 있는 항목 |
| `MODIFIED` | 양쪽에 있지만 내용이 다른 항목 |
| `IDENTICAL` | 같은 항목 |

Git을 Target으로 선택하면 비교 전용으로 동작한다. Git으로 커밋하거나 push하는 기능은 제공하지 않는다.

## 확인한 변경을 Org에 배포하기

1. **DESIRED SOURCE**에 반영할 Git·로컬 프로젝트 또는 Org를, **TARGET**에 배포할 Salesforce Org를 선택한다.
2. 메타데이터를 비교한 뒤 필요한 컴포넌트의 체크박스를 선택한다.
3. Apex가 포함되면 테스트 수준과 실행할 테스트 클래스를 확인한다.
4. **배포 대상 Dry-run**으로 검증하고 결과를 확인한다.
5. 대상 Org 별칭과 `실제 배포` 확인 문구를 입력한 뒤 **배포 대상 실제 배포**를 누른다.

Dry-run은 Org에 변경을 반영하지 않는다. 성공 후 배포할 때는 검증한 배포 파일의 체크섬을 다시 확인한다. `TARGET ONLY` 항목은 자동 삭제하지 않는다. 팀 서버에서는 대상 Org의 실행 권한도 필요하다.

## CLI로 비교·검증하기

CLI에서는 `local:<경로>`와 `org:<별칭>`을 사용한다. Git 저장소는 로컬에 checkout한 DX 프로젝트 경로로 지정한다.

```bash
# Git에서 checkout한 프로젝트와 로컬 작업 프로젝트 비교
sfud compare --left local:../git-project --right local:../working-project --metadata-type ApexClass --detail

# 로컬 프로젝트와 Org 비교
sfud compare --left local:. --right org:prod --all-metadata --detail

# package.xml 범위만 배포 검증
sfud deploy --from local:. --to prod --manifest manifest/package.xml --dry-run
```

실제 배포는 마지막 명령의 `--dry-run`을 `--execute`로 바꿔 실행한다. 배포 명령은 `--execute`가 없으면 기본적으로 검증만 수행한다.

CLI 비교는 `left → right` 기준으로 `ADDED`(오른쪽에만 존재), `REMOVED`(왼쪽에만 존재)를 표시한다. 결과는 기본적으로 `.sfud/runs/<실행-ID>/`에 저장되며, `reports/report.html`을 브라우저에서 열어 상세 diff를 볼 수 있다.

전체 옵션은 `sfud compare --help`, `sfud deploy --help`로 확인한다.

## 상세 문서

- [설치와 설정](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/configuration.md): 홈 설정, 비밀값, 실행 모드, 패키지 설치
- [Git 연결과 가져오기](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md): 토큰, 등록 브랜치, 동기화, 문제 해결
- [CLI 비교와 배포](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/cli-usage.md): 비교 범위, 리포트, Apex 테스트, manifest
- [웹 UI와 서버 운영](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md): 사용자·권한, Salesforce 인증, 데이터 보관
- [개발과 릴리스](https://github.com/ts2580/sf-unlucky-deploy/blob/main/CONTRIBUTING.md): 소스 실행, 테스트, CI, 배포 절차
