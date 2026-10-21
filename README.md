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
sfud ui --project "/path/to/salesforce-project"
```

Windows x64에서는 SQLite 바이너리를 포함한 번들을 설치할 수 있다.

```powershell
npm install --global --ignore-scripts @trstyq/sf-unlucky-deploy@win32-x64
```

Windows 번들은 SQLite native 바이너리를 포함하며 `sqlite3`의 설치 스크립트와 자동 C++ 빌드를 제거했다. 위 명령으로 설치 스크립트 실행을 생략할 수 있다. 일반판은 SQLite 바이너리 설치가 필요하므로 이 옵션을 사용하려면 `win32-x64` 번들을 선택한다.

정식 일반판은 `latest`, 시험판 일반판은 `next`, Windows 번들은 `win32-x64` 채널을 사용한다. 같은 설치 명령을 다시 실행하면 해당 채널의 버전으로 갱신된다.

`--project`에는 `sfdx-project.json`이 있는 로컬 Salesforce DX 프로젝트 경로를 넣는다. 여러 프로젝트는 옵션을 반복해서 등록하고, Git과 Org만 사용할 때는 생략한다.

새 환경에서는 설치 후 첫 `sfud ui` 실행과 `sfud init`(또는 `sfud config init`)이 같은 개인용 기본 설정을 만든다. `LOCAL=true`, 설정 폴더 기준 `data/local`, UUID 기반 `SFUD_TOKEN_SECRET`을 준비한다. npm 설치 단계에서는 설정을 만들지 않으므로 Windows 번들의 `--ignore-scripts` 설치에서도 첫 실행 시 적용된다. 브라우저에서 **http://127.0.0.1:27546**을 열면 별도 SFUD 로그인 없이 사용할 수 있다. 기존 설정·비밀값 파일과 환경변수는 보존하며, 명시한 `LOCAL=false`도 유지한다. 설정 위치는 `sfud config path`로 확인한다. 기존 팀 서버를 개인용으로 전환할 때는 기존 DB를 재사용하지 말고 별도 데이터 경로를 사용한다.

Org도 비교하려면 UI를 실행한 OS 계정에서 미리 로그인하거나 **인증 관리 → Salesforce**에서 연결한다.

```bash
sf org login web --alias dev
sf org login web --alias prod
```

팀 서버에서 여러 사용자가 접속할 경우에는 [웹 UI와 서버 운영](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md)의 `LOCAL=false` 설정을 따른다.

### 종료와 업데이트

다른 터미널에서도 같은 OS 계정과 설정 경로로 실행한 UI를 정상 종료할 수 있다.

```bash
sfud stop
# 여러 UI가 실행 중이면 포트로 선택
sfud stop --port 27546
```

진행 중인 작업과 DB 연결 정리가 끝나면 종료 성공을 표시한다. 실행 중인 UI가 없으면 그대로 끝난다. 이 명령을 지원하지 않는 이전 버전은 실행 터미널에서 `Ctrl+C`로 종료한다. Windows에서는 UI 종료 후 설치 명령을 다시 실행한다.

npm 재설치는 홈 설정·암호화 키·DB를 삭제하지 않는다. 새 기본 DB는 Linux/macOS의 `~/.sfud/data/local/sfud.db`, Windows의 `%USERPROFILE%\.sfud\data\local\sfud.db`에 저장한다. `SFUD_CONFIG_DIR`나 데이터 경로를 바꾸면 다른 DB를 열며, 기존 설정이 실행 폴더 기준 경로를 사용했다면 실행 폴더도 확인한다.

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

새 환경의 `sfud init` 또는 첫 `sfud ui` 실행에서 Git 토큰 저장용 암호화 키도 준비된다. 기존 설치에 키가 없는 경우에는 `sfud config path`에 표시되는 설정 파일과 같은 디렉터리의 `secrets.env`에 `SFUD_TOKEN_SECRET`을 설정한다. 아래 명령으로 임의 문자열을 만들고, 결과를 `SFUD_TOKEN_SECRET=<생성한 값>` 형태로 저장한 뒤 UI를 재시작한다. 기존 키가 있다면 그대로 사용한다.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

**인증 관리 → Git**에서 **저장소 하나 연결**을 선택하고 제공자, 저장소 Git URL, 읽기 권한이 있는 PAT/API Token을 입력한다. GitHub·GitLab·Bitbucket을 지원한다. 제공자별 토큰 설정과 공개 저장소 가져오기는 [Git 연결 안내](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md)를 참고한다.

**계정으로 저장소 목록 조회**를 선택한 경우에도 목록에서 저장소만 선택해 연결한다. 브랜치는 **비교 및 배포** 화면에서 선택한다. 소스·타겟에는 현재 연결된 저장소마다 한 항목만 표시하며, 연결을 삭제하면 과거 브랜치·가져오기 이력은 선택 목록에 남지 않는다.

셀프호스팅 Git에는 `https://gitlab.example.com/group/project.git`처럼 그룹·저장소 경로까지 포함한 전체 HTTPS clone URL을 입력한다. **설정 → 셀프호스팅 Git 허용 IP → 사설 IP 검사**는 기본적으로 꺼져 있다. 관리자가 검사를 켜면 사설·예약 IP는 허용 목록에 등록한 주소만 연결하며, 설정 변경은 즉시 적용되고 재시작 후에도 유지된다.

### 2. 비교 대상과 범위 선택

1. **비교 및 배포** 화면의 **DESIRED SOURCE**에서 등록한 로컬 프로젝트를 선택한다.
2. **TARGET**에서 연결한 Git 저장소를 선택한다.
3. Git 브랜치를 선택한다. 목록을 조회하는 동안 **브랜치 검색 중……** 문구와 회전 표시가 나오며, 이 단계에서는 코드를 가져오지 않는다.
4. **2번 메타데이터 검색**에서 타입(예: `ApexClass`, `CustomField`)을 선택하고 **메타데이터 비교**를 누른다. 이때 선택한 Git 브랜치의 코드를 가져온 뒤 비교한다. 저장소에 DX 프로젝트가 여러 개면 프로젝트 루트를 선택하고 비교를 이어간다. **현재 타입 비교 실행**을 끄면 버튼이 **메타데이터 다운로드**로 바뀌고 Source만 가져온다.

같은 방식으로 Git ↔ Git, Git ↔ Org, 로컬 ↔ Org, Org ↔ Org도 비교할 수 있다. 양쪽에 Git을 선택하면 각 브랜치를 고르고, 2번에서 선택한 같은 메타데이터 타입을 비교 실행 시 양쪽에서 가져온다.

새 비교를 실행할 때마다 선택한 브랜치의 최신 커밋을 다시 확인한다. 비교가 완료된 뒤 Dry-run과 배포는 그 비교에서 확정한 커밋을 사용하며, 이후 push는 다음 비교부터 반영된다.

### 3. 변경 내용 확인

결과에서 컴포넌트를 열어 XML 값이나 Apex·LWC 파일의 diff를 확인한다. 이름·타입·파일 경로로 검색하거나 상태별로 필터링할 수 있다.

| 화면 상태 | 의미 |
|---|---|
| `NEW` | Source에만 있는 항목 |
| `TARGET ONLY` | Target에만 있는 항목 |
| `MODIFIED` | 양쪽에 있지만 내용이 다른 항목 |
| `IDENTICAL` | 같은 항목 |

Git을 Target으로 선택하면 비교 전용으로 동작한다. Git으로 커밋하거나 push하는 기능은 제공하지 않는다.

### 설치 패키지를 비교에서 제외하기

1. Source 또는 Target에 Salesforce Org를 선택하고, **2번 메타데이터 검색 → 비교에서 제외할 설치 패키지**를 펼친다.
2. **패키지 로딩**을 누르면 네임스페이스가 없거나 공유하는 패키지만 구성요소를 조회한다. 고유 네임스페이스 패키지는 조회 없이 바로 제외할 수 있다. 최대 3개 패키지를 병렬로 조회하고 스피너·처리 건수·조회 중인 패키지 이름을 표시한다. 조회에는 수 분이 걸릴 수 있다.
3. 완료된 패키지의 **구성요소 보기**를 열어 유형·이름을 확인하거나 검색하고, 제외할 패키지만 선택한다. **전체 제외** 슬라이더로 모든 패키지를 선택·해제할 수 있다. 필요한 구성요소가 아직 없으면 먼저 병렬 로딩하며, 모두 성공했을 때 전체 선택을 적용한다. 기본값은 선택 없음이다.
4. **메타데이터 비교**를 실행하면 선택한 패키지의 구성요소를 Source·Target 양쪽의 비교 결과에서 제외한다. 원본 파일과 배포 파일은 수정하지 않는다.

펼친 패키지 목록은 가로 전체 너비를 사용하고, 화면 폭에 따라 여러 열로 표시해 불필요한 세로 공백을 줄인다.

**네임스페이스가 없는 패키지와 네임스페이스를 공유하는 패키지도 구성요소 로딩에 성공하면 각각 제외할 수 있다.**
실패한 패키지에는 사유를 표시하며 **패키지 로딩**을 다시 눌러 재시도한다. Salesforce가 구성요소 조회를 지원하지 않거나,
같은 Org에 이름까지 같은 패키지가 있어 구분할 수 없으면 구성요소 기준 제외를 허용하지 않는다.
비교 시 설치 여부와 버전을 다시 확인하고, Org 선택이 바뀌면 기존 제외 선택을 초기화한다.
Org를 바꾸거나 화면을 떠나면 진행 중인 패키지 구성요소 조회도 취소한다. 전체·`CustomObject` 비교에서는
부모 XML 안의 선택한 패키지 필드·규칙·레이블만 비교에서 제외하고 나머지 부모 내용을 보존한다.
고유 네임스페이스 패키지는 구성요소 로딩을 생략하고 네임스페이스로 제외한다.

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
