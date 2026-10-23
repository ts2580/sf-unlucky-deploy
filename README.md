# sf-unlucky-deploy

**Git 브랜치와 로컬 프로젝트, Salesforce Org의 메타데이터 차이를 한 화면에서 비교한다.**

Git으로 변경 이력을 관리하더라도 브랜치의 코드, 로컬 작업 내용, 실제 Org 상태를 같은 기준으로 비교하는 일은 번거롭다. sf-unlucky-deploy는 Salesforce 메타데이터 단위로 추가·변경·동일 항목을 찾고, XML·Apex·LWC 파일의 상세 diff를 보여주는 CLI와 웹 UI다.

비교 결과를 검토하고 공유하는 데 사용할 수 있으며, Org에 반영할 필요가 있으면 선택한 항목의 검증·배포로 이어간다.

## 어떤 비교에 쓰나

| 비교 대상 | 확인할 내용 |
| --- | --- |
| Git ↔ Git | 저장소·브랜치 사이의 메타데이터 차이 |
| Git ↔ 로컬 | 브랜치에 반영된 내용과 로컬 작업 내용의 차이 |
| Git ↔ Org | 저장소의 코드와 실제 Org 상태의 차이 |
| 로컬 ↔ Org / Org ↔ Org | 작업 프로젝트와 Org, 두 Org 사이의 차이 |

GitHub·GitLab·Bitbucket 저장소를 연결하고, 비교할 브랜치와 메타데이터 타입을 선택한다. 새 비교는 브랜치의 최신 커밋을 확인하고, 완료된 비교와 후속 검증·배포는 그때 확정한 소스를 사용한다.

## 빠르게 시작하기

Node.js **22.19.0 이상**, npm, Salesforce CLI v2(`sf`), Git이 필요하다.

```bash
npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@latest
sfud ui
```

브라우저에서 **http://127.0.0.1:27546**을 연다. 새 환경의 첫 실행은 개인용 설정과 Git 토큰 암호화 키를 만들며, 같은 PC에서는 별도 SFUD 로그인 없이 사용한다. 기존 설정과 암호화 키는 유지한다.

로컬 Salesforce DX 프로젝트도 비교하려면 `sfdx-project.json`이 있는 경로를 등록한다. `--project`는 반복할 수 있다.

```bash
sfud ui --project "/path/to/salesforce-project"
```

Windows x64에서는 SQLite 바이너리를 포함한 번들을 설치할 수 있다.

```powershell
npm install --global --ignore-scripts @trstyq/sf-unlucky-deploy@win32-x64
sfud ui
```

일반판은 SQLite 설치 스크립트가 필요하다. `--ignore-scripts` 설치는 위 Windows 번들에 사용한다. 정식 일반판은 `latest`, 시험판은 `next`, Windows 번들은 `win32-x64` 채널을 사용한다.

## 웹 UI에서 Git 비교하기


### 1. Git 저장소 연결

**인증 관리 → Git**에서 **저장소 하나 연결**을 선택하고 제공자, 저장소 Git URL, 읽기 권한이 있는 PAT/API Token을 입력한다. GitHub·GitLab·Bitbucket을 지원한다. 제공자별 토큰 설정과 공개 저장소 가져오기는 [Git 연결 안내](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md)를 참고한다.

**계정으로 저장소 목록 조회**를 선택한 경우에도 목록에서 저장소만 선택해 연결한다. 브랜치는 **비교 및 배포** 화면에서 선택한다. 소스·타겟에는 현재 연결된 저장소마다 한 항목만 표시하며, 연결을 삭제하면 과거 브랜치·가져오기 이력은 선택 목록에 남지 않는다.

셀프호스팅 Git, 토큰 암호화 키와 허용 IP 설정은 [Git 연결 안내](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md)를 참고한다.

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

Org를 비교할 때는 **비교에서 제외할 설치 패키지**에서 불필요한 패키지를 선택한다. 네임스페이스가 없거나 공유하는 패키지는 **패키지 로딩**으로 구성요소를 먼저 조회한다. **전체 제외**로 한꺼번에 선택·해제할 수 있으며 기본값은 선택 없음이다.

선택한 패키지는 양쪽 비교에서 제외하고, 원본 파일과 배포 파일은 수정하지 않는다. Org를 변경하면 제외 선택을 초기화한다. 조회 실패 시의 처리와 상세 동작은 [웹 UI 안내](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md)를 참고한다.

## CLI에서 비교하고 리포트 보기

CLI의 소스는 `local:<경로>`와 `org:<별칭>`이다. Git 저장소는 비교할 브랜치를 로컬에 checkout한 뒤 DX 프로젝트 경로로 지정한다.

```bash
# 두 브랜치를 각각 checkout한 DX 프로젝트 비교
sfud compare --left local:../main-project --right local:../feature-project --metadata-type ApexClass --detail

# 로컬 작업 내용과 Org 전체 메타데이터 비교
sfud compare --left local:. --right org:dev --all-metadata --detail
```

CLI 비교는 `left → right` 기준으로 `ADDED`(오른쪽에만 존재), `REMOVED`(왼쪽에만 존재)를 표시한다. 웹 UI의 Source 기준 상태와 방향이 다르므로 결과를 읽을 때 기준을 확인한다.

결과는 기본적으로 `.sfud/runs/<실행-ID>/`에 저장된다. `reports/report.html`을 브라우저에서 열어 상세 diff를 확인할 수 있다. 전체 옵션은 `sfud compare --help`와 [CLI 사용법](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/cli-usage.md)을 참고한다.

## Org를 비교 대상에 추가하기

UI를 실행한 OS 계정에서 Salesforce CLI로 로그인하거나 **인증 관리 → Salesforce**에서 연결한다.

```bash
sf org login web --alias dev
sf org login web --alias prod
```

Git·로컬 비교 흐름에서 Source 또는 Target을 연결한 Org로 바꾸면 같은 방식으로 메타데이터를 비교한다.

## 비교한 변경을 Org에 반영하기


1. **DESIRED SOURCE**에 반영할 Git·로컬 프로젝트 또는 Org를, **TARGET**에 배포할 Salesforce Org를 선택한다.
2. 메타데이터를 비교한 뒤 필요한 컴포넌트의 체크박스를 선택한다.
3. Apex가 포함되면 테스트 수준과 실행할 테스트 클래스를 확인한다.
4. 사전 검증이 필요하면 **배포 대상 Dry-run**을 실행하고 결과를 확인한다.
5. **배포 대상 실제 배포**를 누르고 소스·대상·반영 범위를 확인한 뒤 최종 배포 버튼을 누른다.

Dry-run 없이 실제 배포하면 사전 검증을 생략하고 선택한 테스트 수준으로 바로 배포한다.
Dry-run은 Org에 변경을 반영하지 않는다. 성공 후 승인 배포할 때는 검증한 배포 파일의 체크섬을 다시 확인하고 조건에 맞으면 검증 ID로 Quick Deploy한다. `TARGET ONLY` 항목은 자동 삭제하지 않는다. 팀 서버에서는 대상 Org의 실행 권한도 필요하다.

CLI에서는 manifest 범위를 검증하거나 실제 배포할 수 있다.

```bash
sfud deploy --from local:. --to prod --manifest manifest/package.xml --dry-run
```

실제 배포는 `--dry-run`을 `--execute`로 바꾼다. CLI 배포 명령은 `--execute`가 없으면 기본적으로 검증만 수행한다. 세부 옵션은 `sfud deploy --help`를 참고한다.

## 업데이트와 서버 운영

업데이트 전 실행 중인 UI를 종료한 뒤 설치 명령을 다시 실행한다.

```bash
sfud stop
# 여러 UI가 실행 중이면 포트로 선택
sfud stop --port 27546
```

npm 재설치는 홈 설정·암호화 키·DB를 삭제하지 않는다. `sfud config path`로 설정 위치를 확인할 수 있다. 새 개인용 DB는 Linux/macOS의 `~/.sfud/data/local/sfud.db`, Windows의 `%USERPROFILE%\.sfud\data\local\sfud.db`에 저장한다. 설정·데이터 경로를 바꾸면 다른 DB를 사용한다.

원격 개인용 서버는 `LOCAL=true`와 `SFUD_ACCESS_PASSWORD`를 사용한다. 팀 서버는 `LOCAL=false`에서 사용자·역할·Org 실행 권한을 관리한다. 접속 비밀번호, HTTPS, Salesforce OAuth 콜백과 데이터 보관 설정은 [웹 UI와 서버 운영](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md)을 따른다.

## 상세 문서


- [설치와 설정](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/configuration.md): 홈 설정, 비밀값, 실행 모드, 패키지 설치
- [Git 연결과 가져오기](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/git-integration.md): 토큰, 등록 브랜치, 동기화, 문제 해결
- [CLI 비교와 배포](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/cli-usage.md): 비교 범위, 리포트, Apex 테스트, manifest
- [웹 UI와 서버 운영](https://github.com/ts2580/sf-unlucky-deploy/blob/main/docs/web-ui.md): 사용자·권한, Salesforce 인증, 데이터 보관
- [개발과 릴리스](https://github.com/ts2580/sf-unlucky-deploy/blob/main/CONTRIBUTING.md): 소스 실행, 테스트, CI, 배포 절차

## 프로젝트의 출발점

[Aladin의 classDeploy Lightning Web Component](https://github.com/ts2580/Aladin/tree/main/force-app/main/default/lwc/classDeploy)에서 출발했다. Salesforce 클래스 배포 경험을 바탕으로 Git·로컬·Org의 메타데이터 비교를 중심에 두고, 필요한 변경의 검증과 배포를 연결한다.
