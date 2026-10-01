# npm CLI 홈 설정 보안 계획

작성일: 2026-10-01 KST
상태: `IMPLEMENTED_LOCAL` — GPT-6 Luna high 구현, 주 에이전트 검토 및 Linux 파일·CLI·설치 패키지 검증 완료. 실제 listen과 Windows/macOS 원격 검증 미완료.

## 목적과 범위

npm 설치된 `sfud`가 OS 사용자 홈의 `.sfud/config.json`을 읽도록 구현한다. 일반 설정과 비밀값을 분리하고 CLI 옵션 → 실행 환경변수 → 홈 설정 → 기존 기본값 순서를 적용한다. 설정 파일이 없으면 현재 동작을 유지한다. `sfud config init`은 사용자가 실행했을 때만 개인 LOCAL 모드 설정과 홈 기준 데이터 경로를 생성한다. 테스트와 검증은 임시 홈에서 수행한다.

이번 작업은 기존 npm 배포 준비 변경 위에 추가한다. 사용자 실제 홈 설정, 기존 DB, 키, 실행 중 서버, npm registry와 GitHub 원격 상태는 변경하지 않는다. 기존 DB의 모드 변경 및 데이터 이동은 수행하지 않는다.

## 위협과 통제

| 위협 | 구현 기준 |
|---|---|
| 저장소 안의 설정 파일로 실행 모드·인증 변경 | 현재 디렉터리 탐색 금지. OS 홈 또는 명시적인 절대 경로 `SFUD_CONFIG_DIR`만 사용 |
| 비밀값의 JSON·명령 출력 노출 | 일반 설정은 버전 및 제한된 env 키만 허용. secret/token 값은 일반 JSON에서 거부. 선택적인 `secrets.env`는 허용된 비밀 변수만 읽음. init/path 출력에 값 포함 금지 |
| 환경을 통한 임의 코드 실행 | NODE_OPTIONS, PATH, HOME, 임의 키, prototype 관련 키 거부. 셸 source/eval 금지. Node parseEnv로 secrets 파일 파싱 |
| 다른 OS 사용자의 설정·비밀 파일 변경/열람 | POSIX 디렉터리 0700·파일 0600, 현재 uid 소유 및 안전한 기존 권한 확인. Windows는 chmod가 ACL을 보장하지 않으므로 사용자 SID 기반 ACL 생성·검증 구현, 실패 시 로딩/초기화 차단 |
| 링크 및 파일 교체 | 설정 디렉터리·파일의 symlink 및 일반 파일이 아닌 대상 거부. 가능하면 O_NOFOLLOW와 열린 fd의 stat/경로 identity 확인. 크기 제한, 읽기 중 교체 실패 처리. Windows reparse point 검증 |
| 손상 JSON·잘못된 타입·거대 파일 | 제한된 스키마, schema version, boolean/포트/경로 검증, unknown 키 거부, 제한 크기 읽기. 오류에 파일 원문이나 비밀값 포함 금지. 설정 없음만 기존 기본값으로 진행 |
| 키 재생성으로 기존 인증 복호화 불가 | 초기화 시 비밀키 자동 생성/교체 금지. 기존 secret/key-file 환경 설정과 TokenVault 체계 유지. 기존 파일 overwrite 금지 |
| 실행 위치별 데이터 DB 분산 | init이 설정하는 상대 데이터 경로는 설정 디렉터리 기준으로 해석. CLI/환경 경로는 기존 의미 유지. LOCAL과 공용 DB 분리 유지 |
| 원격 bind·프록시로 개인 인증 노출 | LOCAL 루프백 강제 유지. config에 allow-remote 부여 금지. 환경/파일 host도 기존 --allow-remote 검사 통과 필요 |
| 중간 실패·동시 init | exclusive create, 기존 파일 비변경, 초기화 실패 시 생성한 항목만 안전하게 정리. 쓰기 완료 후 sync. 덮어쓰기·자동 권한 수리 금지 |

## 설정 계약

- `config.json`: `{ "version": 1, "env": { ... } }`. 허용 목록은 LOCAL, SFUD_UI_PORT, SFUD_UI_HOST, SFUD_DATA_DIR, SFUD_PUBLIC_ORIGIN, SFUD_TRUSTED_PROXIES, SFUD_GIT_ALLOWED_IPS, SFUD_GIT_TOKEN_KEY_FILE. 값은 문자열이며 개별 의미를 검증한다.
- `secrets.env`: 선택 파일. 허용된 변수는 SFUD_TOKEN_SECRET, SFUD_SF_OAUTH_CLIENT_ID, SFUD_SF_OAUTH_CLIENT_SECRET. 실행 환경에 이미 있는 값은 빈 값까지 포함해 우선한다. 지원하지 않는 키를 거부한다.
- 파일에서 가져온 data-dir와 key-file 상대 경로는 config 디렉터리 기준으로 해석한다. 저장소 경로 또는 사용자 입력을 코드로 평가하지 않는다.
- `sfud config init`: 기존 설정을 덮어쓰지 않는 초기화. LOCAL=true 및 홈 config 기준 data/local을 저장. 비밀값 없는 주석 템플릿만 필요 시 생성.
- `sfud config path`: 설정 경로만 표시. 비밀값 출력·자동 값 덤프·secret 값을 CLI 인수로 받는 set 명령은 추가하지 않는다.
- help/version/path는 비밀 파일을 읽지 않아도 실행되도록 구성한다. 실제 동작 명령은 안전하지 않거나 손상된 설정을 무시하지 않고 실패한다.

## 실행 및 검증

구현은 사용자 요청에 따라 GPT-6 Luna high에 위임하고 주 에이전트가 검토한다. security boundary 회귀 테스트(권한, 링크/교체, 스키마, 주입, secret 분리 및 비출력, precedence, 파일 부재, init 동시성/재실행, 상대 경로, 모드/원격 접근)를 추가한다. 실제 CLI subprocess와 설치 tarball에서 임시 홈 초기화 → 다른 CWD 실행 → SQLite 재시작 보존을 확인한다. Node 최소 지원 22.19와 현재 24에서 검증하고 저장소 루트 `npm run build`, typecheck/quality 및 기존 테스트를 수행한다. Windows ACL 검증은 실제 Windows CI 전까지 원격 검증 완료로 표시하지 않는다.

근거: Node 공식 [파일 시스템 문서](https://nodejs.org/docs/latest-v22.x/api/fs.html)는 open flags/exclusive create와 Windows chmod 제한을 설명한다. [OS 문서](https://nodejs.org/docs/latest-v22.x/api/os.html#oshomedir)는 OS별 사용자 홈 계산을 설명한다. 이번 계획은 파일시스템과 OS 계정 경계를 신뢰하며, 같은 OS 계정이 이미 장악된 경우의 격리는 보장하지 않는다.

## 구현 및 검증 결과

GPT-6 Luna high가 `src/config/user-config.ts`, CLI preAction hook, config init/path, host 우선순위, 오류 코드, README와 보안 회귀 테스트를 구현했다. 주 에이전트가 검토하면서 Windows SID 비교/ACL identity, 제한 크기 읽기, 파일/디렉터리 교체 검사, 오류 메시지 비밀값 비출력, 잘못된 따옴표 처리와 도움말 검사 우회 경로를 보완하도록 전달했다. 초기화는 config.json만 생성하며 비밀값 파일이나 키를 자동 생성하지 않는다. Windows ACL은 현재 사용자 SID의 FullControl만 허용하며, 보호된 디렉터리에서 그 권한만 상속한 일반 파일도 허용한다.

- `npm run typecheck`, `npm run quality`, 저장소 루트 `npm run build`: PASS.
- 홈 설정 테스트: Linux 7 PASS, Windows ACL 1 SKIP. 추가 실제 CLI 테스트 2 PASS. CLI 옵션 값 `--project --help`와 `--project -h`로 설정 검사를 건너뛰지 못하도록 preAction 경계에서 검증.
- 인증·암호화·SQLite·소스 명세 회귀: 8개 파일 71 PASS / Windows ACL 1 SKIP, 추가 CLI 파일 2 PASS. 로그: `working/home-config-security-20261001/security-regression.log`, `cli-security-tests.log`.
- 같은 tarball을 npm 11.20.0으로 임시 global prefix(공백 포함)에 실제 설치. Node 24.20.0과 22.19.0에서 각각 40개 시나리오 PASS. 초기화/재실행 비덮어쓰기, JSON·환경 주입·형식·크기 거부, 오류 비밀값 비출력, 부적절한 POSIX 권한 거부, 환경 우선순위, 설치 UI 정적 자산 및 개인 인증 응답(Fastify inject), SQLite native write, 다른 CWD 재시작 보존, key salt 유지, 기존 DB 모드 변경 거부 확인.
- 실제 TCP 서버 기동은 현재 sandbox의 `listen EPERM` 제한으로 미검증. 전체 `npm run verify`도 네트워크 및 `spawnSync EPERM`을 사용하는 기존 검사에서 실패가 발생하고 완료되지 않아 중단했으며 Playwright에 도달하지 못함. 이전 npm 준비의 556 tests/70 E2E 결과는 홈 설정 변경 전 증거이며 이번 소스의 전체 PASS로 재사용하지 않음.
- npm 정책 검사의 순수 함수 7개 PASS, manifest subprocess 검사는 `spawnSync tar EPERM`으로 실패. 배포 파일 정책과 package metadata는 이번 실제 tarball을 별도로 검사하여 PASS.
- Windows 보안 및 CLI 테스트를 CI의 Windows job에 추가했으나 원격 실행하지 않음. Windows/macOS ACL·실제 서버·registry 설치 증거는 없음.

검증 tarball은 `working/home-config-security-20261001/sf-unlucky-deploy-0.4.0.tgz`이며 600,148 bytes / 557 files이다. 최종 빌드의 dist 파일 553개와 README가 tarball의 내용과 byte 단위로 일치한다. SHA-256: `7a300d211e29219232111eaa2dd4b976bed3b9866e388e21d7c42eb08d8b3fc6`. 최종 evidence는 같은 디렉터리의 `validation.json`에 기록했다.

실제 사용자 홈·DB·키·실행 중 서버 및 원격 상태는 변경하지 않았다. npm 발행은 미실행.

## 완료 판정

- `IMPLEMENTED_LOCAL`: 구현, 보안 회귀 테스트, 빌드, Linux 설치 tarball의 파일/CLI 및 내부 요청 검증 통과. 이번 환경에서 실제 TCP 기동과 전체 verify는 통과하지 못한 상태를 함께 기록.
- `VERIFIED_REMOTE`: Windows/macOS의 실제 CI 설치 및 플랫폼 보안 검사 통과.
- npm 발행과 라이선스 결정은 기존 배포 계획의 별도 단계.


## 2026-10-02 첫 실행 자동 생성 변경

사용자가 다음 버전부터 Linux/Windows에서 홈 설정 폴더를 자동 생성하도록 요청했다. `ui`, `compare`, `deploy` action의 preAction에서 설정이 없으면 사용자 홈 `.sfud/config.json`을 생성한다. npm 설치 후 hook에는 의존하지 않으며, 도움말·버전·경로 조회에는 쓰기 작업을 하지 않는다. 공개 RC1은 그대로 유지하고 후속 배포에 반영한다.

자동 설정은 `{ "version": 1, "env": {} }`이다. 기존 LOCAL 모드, 데이터 위치, CLI/환경변수 우선순위를 유지한다. 명시적 `config init`은 기존 개인 LOCAL 설정을 만들며 기존 파일이 있으면 덮어쓰지 않는다. 자동 초기화 역시 기존 설정·소유자·권한을 변경하지 않으며, POSIX 700/600과 Windows 현재 SID만 허용하는 ACL·링크·파일 검증을 그대로 사용한다. 생성 경쟁 시 자신이 만든 디렉터리와 파일만 정리한다.

비밀값은 자동 생성하지 않는다. `LOCAL=true`는 OS 사용자의 Salesforce CLI 인증을 사용하므로 SFUD_TOKEN_SECRET이 Salesforce 인증에는 필수가 아니다. Git 토큰 저장에는 로컬 모드에서도 필요하다. `LOCAL=false`에서 사용자별 Salesforce 인증을 저장하려면 환경변수 또는 secrets.env로 키를 제공해야 한다. 빈 환경변수는 파일값보다 우선하며 암호화 키 검증에서는 invalid_key가 된다. config.json에 secret을 넣으면 기존 allowlist 검증으로 거부한다.

검증: Node 24.20.0과 최소 Node 22.19.0에서 홈 설정/실제 CLI/명령 검사 각각 18 PASS, Windows 전용 ACL 1 SKIP. 기본 홈 경로(공백 포함) 자동 생성, 환경변수·설정 보존, 도움말·버전·경로 조회의 무생성, unsafe 디렉터리 거부를 확인했다. typecheck·quality·루트 npm run build·diff check PASS. Windows 실제 실행은 미수행이며 기존 Windows CI에서 변경된 테스트를 실행하도록 포함돼 있다. 로그와 validation.json은 working/home-config-auto-20261002에 보관했다. 새 npm 발행은 수행하지 않았다.


## 2026-10-02 secrets.env 자동 생성 추가

사용자가 비밀값 파일도 다음 버전에서 자동 생성하는지 확인하여 자동 생성 범위에 secrets.env를 추가했다. 첫 실제 명령 실행 또는 새 config init에서 생성하며 기존 설정 파일만 있는 경우에도 secrets.env가 없으면 생성한다. 비밀값은 자동 생성하지 않고 허용 항목을 모두 주석으로 안내한다. 활성화된 빈 환경변수를 넣지 않으므로 기본 상태는 not_configured로 유지하며, 암호화 키를 임의로 생성하거나 교체하지 않는다.

생성은 O_CREAT|O_EXCL을 사용하고 기존 파일·링크·권한은 변경하지 않는다. Linux는 0600, Windows는 현재 사용자 SID만 허용하는 ACL을 설정한다. 디렉터리/파일 identity와 읽기 보안 검증을 유지하며 실패 시 생성한 inode와 일치하는 파일만 정리한다. 자동 생성 이후에도 기존 secrets.env의 내용은 보존하고 환경변수 우선순위는 유지한다. 도움말·버전·경로 조회는 계속 무생성이다.

검증 결과: Node 24.20.0와 22.19.0에서 각각 19 PASS / Windows 전용 1 SKIP. 템플릿에 활성 비밀값이 없는지, 누락된 companion 파일 생성, 기존 설정 및 비밀값 파일 보존, 실제 CLI 첫 실행/도움말 무생성을 확인했다. typecheck·quality·루트 build·diff check PASS. Windows 실제 실행 및 새 npm 발행은 미수행이다. 로그는 working/home-secrets-auto-20261002에 보관했다.
