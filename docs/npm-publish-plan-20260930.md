# npm 배포 계획

작성일: 2026-09-30 KST

이 문서의 상태·발행 기록은 작성 시점의 이력이다. 이후 발행 결과는 아래 후속 기록과 실제 registry를 확인한다.

2026-10-02 릴리스 정책 변경: RC(`vX.Y.Z-rc.N`)의 신규 GitHub Release는 최신 `canary`, 정식(`vX.Y.Z`)은 최신 `main`의 annotated tag에서 생성한다. 아래 초기 계획의 “RC도 최신 main에서 생성” 조건은 이 정책으로 대체한다. npm `next` 발행 및 registry 검증 후 `latest` 별도 승격 절차는 유지한다. 수동 npm 발행 시 대상 브랜치 이력과 GitHub Release의 prerelease 여부를 재검증하며, 브랜치가 전진해도 같은 릴리스 산출물의 재시도를 허용한다. `workflow_dispatch` 워크플로는 기본 브랜치에도 존재해야 한다.

## 목표와 작업 범위

npm registry를 개인 개발자용 CLI·로컬 웹 UI의 주 설치 경로로 제공한다. GitHub Release의 tarball, 체크섬, SBOM은 유지하고 npm에도 같은 tarball을 발행한다. Docker는 팀 공용 서버 운영 수요가 확인된 뒤 별도 작업으로 진행한다.

이 계획 문서의 최초 작성은 실행 범위를 기록한 단계였다. 후속 구현은 리뷰 수정이 반영된 `feature/npm-distribution` 소스에서 진행했다. 사용자가 MIT를 선택하여 LICENSE, package.json과 잠금 파일의 라이선스 및 private=false를 반영했다.

## 현재 확인된 상태

| 항목 | 2026-09-30 확인 결과 | 계획에 반영할 사항 |
|---|---|---|
| 패키지 | `sf-unlucky-deploy`, 로컬 버전 `0.4.0`, `private: true` | 라이선스 확정 후 private=false 전환, 발행 버전 확정 |
| 실행 명령 | `sfud` → `dist/cli.js`, CLI 버전은 `src/program.ts`에 별도 선언 | 패키지·CLI·태그·잠금 파일 버전 일치 검사 |
| 포함 파일 | `dist/`, README, THIRD_PARTY_NOTICES, npm-shrinkwrap | UI 자산 포함과 금지 파일 부재를 tarball에서 검사 |
| 릴리스 | annotated tag가 최신 `origin/main`을 가리킬 때 검증·pack·설치 smoke·GitHub Release 발행 | 기존 검증 재사용, npm 발행 단계 분리 |
| 실제 GitHub Release | 공개 저장소 `ts2580/sf-unlucky-deploy`, 최신 공개 Release `v0.3.0`; `v0.4.0` Release 조회는 실패 | 로컬 `0.4.0`과 릴리스 문서를 공개 완료로 취급하지 않음 |
| npm 이름 조회 | 명시적인 공개 registry에서 `npm view sf-unlucky-deploy name version --json` 결과 E404 | 현재 공개 패키지 조회 불가. 이름 확보·발행 권한을 뜻하지 않으므로 재확인 |
| 라이선스 | 프로젝트 LICENSE 파일과 `package.json.license` 없음. 제삼자 고지만 존재 | 사용자에게 프로젝트 라이선스 선택을 받아 반영 |
| 지원 환경 | 계획 작성 당시 Node `>=20.19`; 새 production dependency의 `undici`가 Node `>=22.19` 요구 | npm 배포 기준 `>=22.19.0`, Node 24 권장, Linux 22.19/24 및 Windows/macOS 24 설치 matrix로 반영 |
| 로컬 도구 | Node 24.20.0, npm 12.0.2; 기존 패키징 정책은 npm 11.7.0 | 설치 스크립트 허용 옵션을 지원하는 npm 11.20.0으로 pack·smoke·publish 정책 갱신 |

위 결과는 이번에 읽은 작업 트리와 GitHub/npm 조회 기준이다. 리뷰 수정 완료 후 파일과 원격 상태를 다시 확인한다. 기존 릴리스 문서에 기록된 테스트 수는 이번 npm 배포 검증 결과로 재사용하지 않는다.

## 배포 정책과 결정 사항

- 사용자가 개인 scope를 선택하여 발행 이름은 `@trstyq/sf-unlucky-deploy`로 확정했다. 실행 명령은 `sfud`를 유지한다. GitHub 계정명과 npm 계정명이 같다고 가정하지 않는다.
- CLI 명령 `sfud`와 CLI·UI 통합 패키지 구조를 유지한다. 별도 라이브러리 API나 CLI/UI 패키지 분리는 이번 범위에 넣지 않는다.
- Node·Salesforce CLI v2·Git은 사용자 사전 설치 요구 사항이다. 이 패키지에서 Salesforce CLI를 자동 설치하거나 인증 설정을 덮어쓰지 않는다.
- `npm-shrinkwrap.json`은 CLI 설치 의존성 고정을 위해 유지한다. 업데이트 시 두 잠금 파일의 그래프 동기화와 설치 검증을 반복한다. [npm shrinkwrap 공식 문서](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/)
- 프리릴리스는 `next`, 검증 완료한 안정판은 `latest`를 사용한다. prerelease의 `latest` 발행은 차단한다. 안정판 후보를 `next`에 먼저 발행하는 검증 단계는 허용한다.
- 첫 공개 배포 후보는 `0.4.0-rc.1`, 안정판 후보는 `0.4.0`이다. 구현 시 다른 릴리스가 먼저 나왔다면 다음 사용 가능한 버전으로 조정한다. 기존 태그를 이동하거나 기존 tarball을 교체하지 않는다.
- Node 24 LTS를 권장 설치 환경으로 삼고 신규 npm 최소 지원 기준은 Node 22.19.0으로 정한다. 실제 production dependency의 `@jsforce/jsforce-node` 내 `undici`가 `>=22.19.0`을 요구하므로 Trusted Publishing 공식 최소치인 22.14.0보다 높은 기준이 필요하다. CI와 설치 문서를 같은 값으로 유지한다. [Node 릴리스 상태](https://nodejs.org/en/about/previous-releases)

프로젝트 라이선스는 사용자가 MIT로 확정했다. 2026-10-01 로그인 후 공개 npm registry의 `npm whoami`로 발행 계정 `trstyq`를 확인한 이력이 있다. 이후 제한 환경에서 재조회는 DNS 오류로 실패했다. 패키지 이름 조회는 이전 E404 증거만 있으므로 이름 사용 가능 여부와 실제 발행 권한은 registry 접근 복구 후 재확인한다. 최소 Node 지원은 production 의존성에 맞춰 `>=22.19.0`으로 정했다.

## 구현 순서

### 1. 리뷰 수정 완료 소스와 배포 메타데이터 확정

- 리뷰 수정의 최종 커밋/변경 범위를 확인하고 별도 작업 브랜치 `feature/npm-distribution`에서 패키지·CI 변경 진행. 다른 작업자의 체크아웃을 바꾸지 않도록 필요하면 별도 worktree 사용.
- `package.json`에 `repository`, `homepage`, `bugs`, `license`, 검색용 keywords 추가. 저장소 URL은 `https://github.com/ts2580/sf-unlucky-deploy`와 일치하도록 설정.
- 선택된 라이선스의 LICENSE 추가, 기존 THIRD_PARTY_NOTICES 유지. 제삼자 Apache 고지를 프로젝트 전체 라이선스로 간주하지 않음.
- `publishConfig.registry`를 `https://registry.npmjs.org/`, `publishConfig.access`를 `public`으로 지정. 라이선스 확정 후 `private: false`로 전환하고 실제 publish는 별도 실행.
- package·CLI·잠금 파일 버전을 함께 변경. 기존 `release:check`에 CLI 선언 및 lockfile root version 검사 보완.
- `files` 허용 목록 유지. 환경 설정 예시를 배포할 필요가 있으면 `.env.example`만 명시적으로 포함하고 설치 문서 작성.
- 소스 저장소의 `start-local.sh`/`sfud.ps1`에 의존하지 않는 설치·실행 설명 제공. CLI는 프로젝트 `.env`를 자동으로 읽지 않으며, 후속 홈 설정 로더를 통해 `~/.sfud/config.json`과 선택적인 `secrets.env`를 읽는다. 셸별 환경변수는 파일 값보다 우선한다.

완료 기준: 공개 패키지 메타데이터 완비, 이름/버전/CLI/잠금 파일 일치, 사용자 결정 사항 반영.

### 2. 단일 tarball 생성과 설치 검증 보강

- 깨끗한 checkout에서 기존 `lockfile:check`, `verify` 실행. 구현 변경 후 저장소 루트 `npm run build` 완료.
- Node 24와 명시적으로 고정한 npm 11.20.0으로 pack·SBOM 생성. npm 11.7.0에는 설치 스크립트 허용 옵션이 없어 pack·smoke·publish의 도구 정책을 같이 변경했다. npm 11.20.0은 최소 Node 22.19.0에서도 실행 가능하다.
- 생성 tarball 하나를 OS별 설치 matrix와 이후 발행의 입력으로 전달. 각 OS에서 별도로 만든 tarball의 smoke를 최종 산출물 검증으로 대체하지 않음. publish 단계에서 작업 디렉터리를 다시 pack하거나 build하지 않음.
- `scripts/package-smoke.mjs` 보강: 버전·도움말만 확인하는 현재 검증에 tarball 파일 목록, 실제 UI 자산 로딩, SQLite 시작·쓰기·종료 검증 추가. Windows에서는 tar/실행 파일 경로를 플랫폼에 맞게 처리.
- 패키지 밖 임시 작업 디렉터리에 설치하고 npm global prefix와 데이터 디렉터리 분리. 소스 checkout이나 개발 node_modules를 참조하면 실패 처리.
- CLI 실행 권한/shebang, `dist/ui/index.html`과 참조된 JS/CSS 존재 확인. `.env`, `.sfud/`, `.sfud-local/`, `.sf/`, `.sfdx/`, DB/WAL/SHM, 키, ZIP, 테스트 fixture와 개발 의존성 파일이 tarball에 들어가지 않았는지 확인. source map의 개발 경로와 소스 포함 여부도 검사.
- 설치 스크립트 허용은 필요한 `sqlite3`로 제한. npm 11.7과 발행 시점의 최신 npm에서 실제 사용자 설치 명령을 검증. `sqlite3` prebuilt 사용/소스 빌드 여부 기록, 컴파일러가 없는 일반 설치 환경도 확인.
- 패키지에 production dependency tree만 설치되는지 `npm ls --all`로 확인. UI 번들용 React 의존성 정리는 별도 필요성이 확인된 경우에만 수행.

| 검증 환경 | 필수 검증 |
|---|---|
| Linux x64 / Node 24 | 기존 전체 검증 + tarball 설치 + CLI + SQLite + UI 브라우저 검증 |
| Linux x64 / 확정된 최소 Node | tarball 설치·실행 및 지원 버전 검증 |
| Windows x64 / Node 24 | 실제 tarball 설치 + `sfud.cmd` 실행 + SQLite + UI 시작·자산 로딩 + 공식 sf 실행 경로 |
| macOS arm64 / Node 24 | 실제 tarball 설치 + SQLite native binding + UI 시작·자산 로딩 + sf/Git 실행 |
| Linux arm64 | 첫 안정판 필수 범위에서 제외. 실제 설치 검증 전에는 ARM 서버/NAS 지원 완료로 표기하지 않음 |

설치된 UI는 `LOCAL=true`, 별도 임시 데이터 디렉터리, `--no-open`으로 실행한다. `/api/v1/health`, 홈 화면, 빌드된 JS/CSS 로딩, SQLite 쓰기 후 재시작과 상태 보존, 프로세스 종료를 확인한다. 브라우저 console/page error와 로그인/LOCAL 모드 표시를 확인하고 실제 사용자 DB를 사용하지 않는다.

npm 배포 검증은 실제 Salesforce 운영 배포를 요구하지 않는다. 기존 리뷰 수정의 인증 격리·배포 경계 검증을 필수 선행 조건으로 삼고, 설치 패키지의 실제 Org 읽기/비교/check-only 검증은 허용된 테스트 Org에서 별도 실행 및 보고한다.

완료 기준: 지정한 OS/Node에서 소스 저장소 없이 설치 패키지의 CLI·UI·SQLite 동작 확인, tarball·SBOM·SHA256SUMS 보관. 로컬 tarball PASS는 npm registry 설치 PASS와 구분.

### 3. GitHub Release와 npm 발행 연결

기존 `release.yml`은 검증·tarball 생성·GitHub Release를 담당한다. 별도 `publish-npm.yml`은 `workflow_dispatch`로 정확한 Release 태그를 받아 해당 tarball을 npm에 발행한다. 준비/자동화 구현과 외부 발행 실행을 분리하고, 기존의 모든 `v*` 태그가 곧바로 npm 발행을 일으키도록 바꾸지 않는다.

- `release.yml`: tag/package/CLI 버전 검사, 잠금 파일 검사, 설치 matrix 결과 확인, prerelease 버전이면 GitHub prerelease로 발행. 현재 `gh release create`는 prerelease 구분을 추가해야 함.
- 최초 릴리스 생성은 기존 annotated tag/최신 main 조건 유지. 오래된 패키지 릴리스를 최초 npm 안정판으로 발행하지 않도록 후보 검토.
- `publish-npm.yml`: main과 대상 릴리스 태그에 워크플로 파일이 존재해야 함. 수동 실행 ref는 대상 릴리스 태그로 지정하고 입력 태그·`github.ref`·`github.sha`·annotated tag의 peeled commit 일치 검사. provenance가 다른 main 커밋을 가리키지 않도록 함. 동일 저장소 Release 존재, draft 여부, 버전/dist-tag 정책, Release 대상 커밋/빌드 증거 확인.
- GitHub Release에서 `.tgz`, SHA256SUMS, SBOM 다운로드. 태그·커밋·빌드 run ID·파일 이름·체크섬을 묶은 manifest 추가. 입력 태그를 셸 문자열에 직접 삽입하지 않음.
- checksum 파일은 허용된 고정 파일명만 수용. tarball 내부 name/version/metadata와 설치 smoke 결과 확인 후 발행. npm publish는 tarball 경로에 `--ignore-scripts`를 사용해 재빌드 hook 없이 수행.
- 동일 package/version이 이미 존재하면 registry tarball의 바이트/해시를 비교. 동일하면 발행 단계를 건너뛰고 후속 검증 재개, 다르면 오류 종료.
- 패키지 단위 발행 concurrency, `cancel-in-progress: false` 적용. `latest`보다 낮은 버전이 default tag를 되돌리지 못하도록 현재 registry 버전과 비교.
- 재시도는 원래 승인된 태그/커밋/tarball을 검증. main이 이후 전진했다는 이유만으로 동일 산출물의 사후 검증·복구를 막지 않음. 새 산출물을 만드는 작업은 새 릴리스로 처리.
- PR 검증 job에는 발행 권한을 주지 않음. 발행 job만 `id-token: write`, `contents: read` 사용. 기본 PR/build 과정에 npm 인증 정보가 필요하지 않도록 구성.

완료 기준: 실제 발행 없는 준비 검증 통과, 준비 PR의 필수 검사 성공, 사용자 수동 병합을 거쳐 워크플로가 main에 존재.

### 4. 최초 발행과 Trusted Publishing 설정

기본안은 첫 RC를 계정 소유자의 대화형 npm 인증으로 발행한 뒤, 생성된 패키지 설정에 Trusted Publisher를 등록하는 순서다. 초기 패키지 생성 없이 설정 가능한 다른 방식이 있으면 구현 시 공식 절차를 재확인한다.

1. 라이선스·계정·패키지 이름·버전 결정 및 준비 PR 검증 완료.
2. 작업 브랜치 → canary PR, canary → main PR 순서로 사용자 수동 병합. main 승격 작업의 Slack 보고 정책 준수.
3. 사용자에게 실제 태그 생성/push와 발행할 RC 산출물·체크섬·검증 결과 제시. 해당 외부 작업 승인 후 기존 릴리스 흐름으로 RC GitHub prerelease 생성.
4. RC tarball을 다시 다운로드·검증한 뒤 소유자가 npm에 `--access public --tag next`로 최초 발행. 첫 수동 발행은 OIDC provenance 확인 완료로 보고하지 않음.
5. npm 패키지 설정에 `ts2580` / `sf-unlucky-deploy` / `publish-npm.yml` Trusted Publisher 등록. 환경 이름을 사용하는 경우 workflow와 정확히 일치시킴.
6. 직접 `npm publish`를 사용하는 계획이므로 Trusted Publisher의 allowed actions에 이를 명시적으로 허용. 현재 새 설정은 stage publish만 기본 허용될 수 있음. 발행은 단일 최상위 워크플로에서 수행하고 workflow_dispatch의 인증 매칭은 실제 RC 발행으로 확인.
7. 새 RC 버전으로 OIDC 발행과 registry 설치 검증 수행. 최초 RC 버전을 덮어써서 시험하지 않음.
8. RC 검증 후 안정판 버전으로 다시 build·pack·설치 검증. 안정판 tarball의 registry 검증을 마친 다음 `latest` 공개.

OIDC 발행은 GitHub-hosted runner, Node 24, 고정 npm 11.20.0을 사용한다. 공식 최소 요구 사항은 Node 22.14 이상·npm 11.5.1 이상이며 공개 저장소/공개 패키지 조건에서 provenance가 자동 생성된다. 장기 npm 쓰기 토큰은 기본안에 넣지 않는다. [Trusted Publishing 공식 문서](https://docs.npmjs.com/trusted-publishers/)

안정판도 우선 `next`로 발행해 registry 설치를 검증한 뒤 같은 버전으로 `latest`를 이동한다. dist-tag 변경은 publish OIDC 대상과 다르므로 계정 소유자의 대화형 인증으로 수행한다. [Trusted Publishing의 인증 범위](https://docs.npmjs.com/trusted-publishers/)

`next`는 후보 채널로 안내하고 일반 사용자 설치는 `latest`를 사용한다. [dist-tag 공식 문서](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

완료 기준: RC OIDC 발행·provenance·registry 설치 검증 확인, 첫 안정판 `latest`가 검증된 버전을 가리킴. 외부 설정 변경·태그 push·발행은 현재 계획 작성 요청에 포함되지 않음.

### 5. registry 검증과 설치 문서 전환

- `npm view <package>@<version>`으로 version, dist.tarball, dist.integrity, dist.shasum, dist-tags, provenance 조회. registry tarball을 직접 내려받아 GitHub tarball과 바이트/SHA-256 일치 확인.
- 캐시가 없는 임시 prefix와 작업 디렉터리에서 정확한 registry 버전을 설치. 설치 로그, npm/Node/OS/architecture, dependency tree, CLI 버전, UI·SQLite 검증 결과 저장.
- Linux·Windows·macOS에서 registry 설치 명령 검증. 필요한 설치 스크립트 정책을 OS별 문서에 반영. npx 실행도 별도 캐시에서 검증한 경우에만 안내.
- README의 “npm registry에는 발행하지 않는다”를 수정하고 npm 설치를 첫 설치 경로로 제시. GitHub tarball 직접 설치와 SHA256SUMS 확인은 대안으로 유지.
- `LOCAL=true` 환경변수 설정은 POSIX와 PowerShell 예시를 각각 제공. 현재 LOCAL 기본값은 false이므로 `sfud ui`만 실행해 로그인 없는 개인 모드가 된다고 안내하지 않음.
- CLI 직접 실행 시 프로젝트 `.env`를 자동 적용하지 않는 점, CWD와 데이터 디렉터리 위치, 사용자/공용 모드의 DB 분리, Salesforce CLI/Git 사전 설치 안내.
- 업그레이드 전에 서버 종료·데이터 및 암호화 키 백업 안내. 다른 버전으로 같은 DB를 되돌려 열 수 있다고 가정하지 않음.
- 실제 확인한 최신 테스트 결과로 릴리스 노트 갱신. 기능 구현·설치 검증·실제 Org 검증의 범위 분리.

발행 후 사용할 설치 예시의 형태는 다음과 같다. 실제 패키지 이름과 버전은 확정 후 대입한다.

```bash
npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@<확정버전>
sfud --version
sfud --help
```

```bash
# POSIX 셸: 개인 로컬 웹 UI
LOCAL=true sfud ui
```

```powershell
# PowerShell: 개인 로컬 웹 UI
$env:LOCAL = 'true'
sfud ui
```

## 실패·재시도·복구

- registry 발행 전에 실패: npm 변경 없음. 오류 수정 후 같은 검증 절차 재실행.
- publish 응답 실패/시간 초과: 즉시 재발행하지 말고 package/version과 registry tarball을 조회해 실제 발행 여부 확인.
- npm 발행 성공·후속 검증 실패: 해당 버전은 발행됨으로 기록. 안정판 `latest` 이동 중단, 원인에 따라 수정 버전 발행 또는 해당 버전 deprecate 검토.
- 동일 name/version은 삭제 후에도 재사용할 수 없음. unpublish로 버전 덮어쓰기를 시도하지 않음. [npm publish 공식 문서](https://docs.npmjs.com/cli/v11/commands/npm-publish/)
- GitHub Release만 성공: 상태는 GitHub 산출물 공개 완료 / npm 미발행. 기존 tarball로 npm 단계를 재개.
- `latest` 공개 후 결함 발견: 이전 검증 버전이 있으면 dist-tag 복구 검토. 첫 npm 안정판은 이전 registry 안정판이 없으므로 수정 버전·deprecate·설치 안내 갱신으로 대응.
- 버전 변경/deprecate/dist-tag 복구 등 외부 쓰기는 해당 작업에 대한 사용자 승인 범위에서 수행. 사용자 데이터의 downgrade는 백업 복원 검증 없이 권장하지 않음.

## 변경 예정 파일과 작업 구분

| 작업 | 변경 대상 | 의존성 |
|---|---|---|
| 패키지 메타데이터·버전 | package.json, package-lock.json, npm-shrinkwrap.json, src/program.ts, LICENSE | 리뷰 수정 완료, 계정·라이선스·지원 Node 확정 |
| 배포 후보 검사 | scripts/check-release-version.mjs, 패키지 검사 스크립트 | 메타데이터 정책 |
| 설치/런타임 검증 | scripts/package-smoke.mjs, 설치 smoke 지원 파일 | 확정된 OS/Node matrix |
| CI·산출물 | .github/workflows/ci.yml, release.yml, 새 publish-npm.yml | smoke/manifest 완성 |
| 사용자 설치 문서 | README.md, 새 버전 docs/releases 문서, 필요 시 .env.example | 실제 설치 명령 검증 |
| 외부 계정/발행 | npm 패키지·Trusted Publisher·dist-tags, GitHub tag/Release | 사용자 승인, main 수동 병합, 산출물 검증 |

최초 계획 작성 후 위 패키징·CI·문서 구현을 진행했다. 저장소의 PR 정책대로 에이전트는 PR 작성·검증 상태 확인까지 수행하며 병합은 사용자가 직접 수행한다.

## 완료 판정

- [x] `IMPLEMENTED_LOCAL`: 배포 준비용 메타데이터·패키징·CI·문서 구현, 잠금 파일 동기화와 build/verify 통과. 라이선스와 공개 플래그 확정은 발행 선행 조건으로 남음.
- [ ] `VERIFIED_REMOTE`: 같은 릴리스 후보의 CI matrix, GitHub 산출물·checksum·commit, registry tarball 동일성, 실제 registry 설치 및 provenance 확인.
- [ ] `DEPLOYED`: 확정된 안정판 npm 발행, registry 설치 검증, `latest` 조회 일치, GitHub Release의 같은 tarball·SBOM·SHA256SUMS 확인.

실제 npm registry 발행, npm Trusted Publisher 설정, 라이선스 결정, tag 생성/push, 커밋·원격 push는 수행하지 않았다. 초기 계정 조회는 ENEEDAUTH였으나, 사용자의 로그인 이후 2026-10-01 `npm whoami --registry=https://registry.npmjs.org/` 재조회는 `trstyq`로 성공했다. 로그인 확인은 실제 패키지 발행이나 이름 확보를 뜻하지 않는다.

## 로컬 검증 결과 (2026-10-01 KST)

요청한 GPT-6 Luna high 에이전트가 준비 구현을 수행하고 주 에이전트가 검토·보완·최종 검증했다. 작업 브랜치는 `feature/npm-distribution`, 기준 커밋은 `c937309`이며 현재 준비 변경은 커밋되지 않았다.

| 검증 | 결과와 증거 |
|---|---|
| 전체 검증 | `npm run verify` PASS — Vitest 79개 파일·556건, Playwright 70건 통과. [로그](../working/npm-distribution-20260930/verify.log) |
| 패키징·발행 회귀 | 정책 테스트 8/8 PASS — 오염 경로, 메타데이터 불일치, tag/ref/SHA 불일치, registry 네트워크 오류, 동일 버전 다른 tarball, manifest 생성·검증 및 checksum 오염 거부. [로그](../working/npm-distribution-20260930/npm-policy.log) |
| 최종 빌드·정적 검사 | `npm run build`, lint, lockfile:check, release:check(v0.4.0), actionlint 1.7.12+shellcheck, diff --check PASS. [최종 빌드 로그](../working/npm-distribution-20260930/final-build.log) |
| 동일 tarball 설치 | npm 11.20.0 / Node 24.20.0 및 22.19.0에서 CLI·UI 자산·SQLite 쓰기·재시작 보존 PASS. npm/CLI 자식 프로세스도 선택한 Node를 사용. [Node 24 로그](../working/npm-distribution-20260930/smoke-node24.log), [Node 22.19 로그](../working/npm-distribution-20260930/smoke-node22.19.log) |
| 최신 npm 설치 | npm 12.2.0 / Node 24.20.0에서 새 cache와 공백이 포함된 prefix로 최종 tarball 설치 PASS. 최신 npm 12.2는 최소 Node 요구가 더 높으므로 Node 22.19 검증에는 npm 11.20 사용. [설치 로그](../working/npm-distribution-20260930/install-npm12.2.log) |
| 설치 패키지 브라우저 | 소스 저장소 밖 설치 prefix에서 LOCAL UI 실행. Chromium 1440px·320px에서 대시보드 표시, document/body 가로 넘침 없음, console/page/request 오류 0건. [측정 결과](../working/npm-distribution-20260930/installed-browser.json) |
| 산출물 | npm 11.20.0 pack·SBOM·SHA256SUMS 생성. tarball 내 dist 파일 549개가 최종 build와 바이트 일치. [tarball](../working/npm-distribution-20260930/sf-unlucky-deploy-0.4.0.tgz), [체크섬](../working/npm-distribution-20260930/SHA256SUMS) |

최종 tarball SHA-256: `6388500d31d9e0df959343dfa0c30f7a9dba33a65d2e8c019ae8d7c7e08bb590`.

Windows/macOS matrix는 구현만 완료했으며 원격 실행하지 않았다. 로컬 tarball 설치와 브라우저 검증은 registry 설치·OIDC 인증·provenance 확인을 뜻하지 않는다. 기존 실행 서버 PID 2505496 / 192.168.0.62:27546은 재시작하거나 변경하지 않았다.

## 홈 설정 보안 후속 작업 (2026-10-01 KST)

사용자 요청에 따라 GPT-6 Luna high가 홈 설정 로더와 `sfud config init/path`를 구현했고 주 에이전트가 검토했다. 상세 위협/통제/검증은 [홈 설정 보안 계획](home-config-security-plan-20261001.md)에 기록했다. npm 초기 사용은 새 후보 설치 후 `sfud config init`과 `sfud ui`로 진행하며, 기존 설정·DB·키는 자동으로 덮어쓰거나 이동하지 않는다.

변경 후 로컬 파일·실제 CLI·암호화·SQLite 회귀와 설치 tarball 검증은 통과했다. Node 24.20.0 및 22.19.0에서 같은 설치 패키지의 40개 시나리오를 각각 검증했다. sandbox의 listen/spawnSync EPERM으로 전체 verify 및 실제 서버/Playwright 검증을 완료하지 못했으므로 위의 변경 전 전체 테스트 결과를 현재 최종 소스 검증으로 간주하지 않는다. 발행 전 원격 CI 전체 검증과 Windows/macOS 설치 검사 통과가 필요하다.

시험 발행은 `0.4.0-rc.1`을 `next`로 제공하고 registry 설치를 검증한다. 수정은 `rc.2` 등 새 버전으로 발행하며, 정식 `0.4.0`도 우선 `next`로 발행하여 같은 tarball 설치를 확인한 뒤 `latest`를 승격한다. 이번 작업에서는 실제 발행·버전 변경·latest 변경을 실행하지 않았다.

## 실제 발행 요청 후 확인 (2026-10-01 KST)

사용자가 npm 발행을 명시적으로 요청했다. 앞서 논의한 시험 배포 흐름에 따라 이름 `sf-unlucky-deploy`, 버전 `0.4.0-rc.1`, 채널 `next`를 목표로 package.json·CLI·두 잠금 파일을 맞췄다. 라이선스 선택은 사용자 입력을 기다리고 있으며 private=true를 유지한다. 발행 요청에 대한 재승인은 필요하지 않다.

이번 환경에서 npm 11.20.0으로 공개 registry의 whoami 및 패키지 버전 조회를 실제 수행했으나 모두 `getaddrinfo EAI_AGAIN registry.npmjs.org`로 실패했다. 이전 trstyq 확인은 과거 로그인 증거이며 이번 인증 확인은 완료되지 않았다. 이름 및 RC 버전 사용 가능 여부도 현재 확인하지 못했다. registry에 publish/write 요청은 보내지 않았다.

RC 후보는 저장소 루트 build, 버전·잠금 파일 검사, CLI 16개 PASS / Windows ACL 1 SKIP를 통과했다. 새로운 RC tarball은 `working/npm-publish-rc1-20261001/`에 보관했다. 라이선스 반영 시 tarball을 다시 만들고 검증해야 하며 현재 private=true·license 미설정 산출물을 발행용 완성품으로 취급하지 않는다. 실제 시험 발행은 라이선스 확정과 registry에 접속 가능한 환경이 확보된 뒤 진행한다.

### MIT 확정 및 발행 명령 실행 결과

사용자가 MIT를 명시적으로 선택했다. LICENSE를 추가하고 package.json의 license=MIT/private=false, 두 잠금 파일의 root license=MIT를 반영하여 build·버전·잠금 파일 검사 후 tarball을 다시 생성했다. 이번 tarball에는 LICENSE가 포함돼 있다.

npm 11.20.0으로 아래와 같은 실제 발행 명령을 실행했으나 exit 1 / EAI_AGAIN(getaddrinfo registry.npmjs.org)으로 실패했다. npm notice는 이름 sf-unlucky-deploy, 버전 0.4.0-rc.1, public access, tag next를 확인했으며 업로드는 완료되지 않았다. latest 변경은 수행하지 않았다.

```bash
npm publish ./working/npm-publish-rc1-20261001/sf-unlucky-deploy-0.4.0-rc.1.tgz --access=public --tag=next --ignore-scripts --registry=https://registry.npmjs.org/
```

최종 산출물: 601,125 bytes / 558 files, SHA-256 `1ade4a0fa3cad84148bfa60c660e622869ca2f3d504a6352a3ab1c605818f166`. `publication-status.json`, `SHA256SUMS`, `publish.log`를 같은 작업 디렉터리에 기록했다. registry에 접속 가능한 환경에서 실제 현재 버전·계정을 조회한 뒤 동일 tarball 발행을 재개한다. 인증 토큰은 기록하지 않았다.


## 2026-10-01 개인 scope 확정

사용자가 `@trstyq/sf-unlucky-deploy`를 발행 이름으로 선택했다. package.json·두 잠금 파일·README·RC 릴리스 안내·배포 workflow·manifest의 scoped tarball 파일명 처리를 변경했다. CLI 실행 명령은 `sfud`, 버전은 `0.4.0-rc.1`, 채널은 `next`, 라이선스는 MIT이다. 이전 unscoped 산출물은 이 이름으로 발행하지 않는다.

루트 build, lint, 버전·잠금 파일, actionlint 검사를 통과했다. 새 tarball의 메타데이터·잠금 파일 이름·허용 파일·LICENSE·UI 자산·dist 바이트 일치와 scoped manifest 생성/검증, checksum/tag/SHA 오염 거부를 검사했다. 동일 tarball을 공백이 포함된 별도 prefix에 설치해 Node 24.20.0과 22.19.0에서 설치 패키지 보안 시나리오 40개씩 통과했다. UI는 Fastify.inject 검사이며 실제 TCP/브라우저 검증이 아니다. 기존 정책 테스트는 7개 통과했고 manifest 테스트 하나는 sandbox의 spawnSync tar EPERM으로 차단됐다. 별도 async 프로세스 검사로 manifest 동작과 오염 거부를 확인했으며 원본 테스트 통과로 대체하지 않는다.

현재 셸에서 registry.npmjs.org와 github.com DNS 조회가 모두 EAI_AGAIN으로 실패한다. 실행 환경에는 네트워크 제한이 걸려 있으며 npm 공식 상태 페이지는 정상으로 표시했다. scoped package 조회도 DNS 단계에서 실패했으므로 현재 이름/버전 존재 여부와 계정 권한을 원격 확인하지 못했다. scoped 발행 명령은 이 조회 실패 이후 실행하지 않았고 npm 발행은 미완료다.

새 산출물은 `working/npm-publish-scoped-rc1-20261001/trstyq-sf-unlucky-deploy-0.4.0-rc.1.tgz`이며 601,181 bytes / 558 files, SHA-256 `7b426ff9a69af84bcfa75330427ee83244cbdead9f38c75b59ebe397b508ee15`이다. 검증 로그와 SHA256SUMS, publication-status.json을 같은 디렉터리에 보관했다.

네트워크가 가능한 일반 터미널에서 `npm ping`, `npm whoami`, scoped name/version 조회를 한 뒤 아래 명령으로 발행을 재개할 수 있다.

```bash
npm publish ./working/npm-publish-scoped-rc1-20261001/trstyq-sf-unlucky-deploy-0.4.0-rc.1.tgz --access=public --tag=next --ignore-scripts --registry=https://registry.npmjs.org/
```


## 2026-10-01 사용자 터미널 시험 발행 완료

사용자가 재로그인 후 시험 발행을 완료했다고 알렸다. 같은 머신의 npm debug log `2026-10-01T12_38_21_404Z-debug-0.log`를 확인하여 `@trstyq/sf-unlucky-deploy@0.4.0-rc.1`, public access, 요청 tag next, shasum `55795af6c1d5c0d6febe16c4a6c6e1a302631935`, registry PUT HTTP 200, npm exit 0 / info ok를 확인했다. 인증정보·브라우저 인증 URL·OTP는 복사하지 않았다. 발행 완료는 로그로 확인했으며 기존 미발행 상태는 이 기록으로 대체한다.

에이전트 실행 환경은 여전히 DNS EAI_AGAIN으로 registry 조회가 실패한다. 별도 web 조회도 실패하여 현재 dist-tags, registry tarball 바이트 일치, 실제 registry 설치는 아직 검증하지 못했다. GitHub Release/OIDC provenance 및 안정판 latest 승격 완료로 보고하지 않는다. 시험판 설치 명령은 `npm install --global --allow-scripts=sqlite3 @trstyq/sf-unlucky-deploy@next`이다. 공개한 기존 RC tarball은 변경하지 않는다.
