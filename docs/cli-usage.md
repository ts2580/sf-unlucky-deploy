# CLI 비교와 배포 상세

[README로 돌아가기](../README.md)

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

[기본 manifest](../manifest/package.xml)는 API 67.0 기준의 일반적인 배포 가능 메타데이터를 포함한다. 비교와 배포 양쪽에 반드시 같은 manifest를 사용한다.

전체 org를 무조건 wildcard로 조회하는 것은 안정적이지 않다. 비교 목적에 맞게 manifest를 작게 나누는 것을 권장한다.

```text
manifest/apex.xml
manifest/objects.xml
manifest/permissions.xml
```

diff 결과만으로 destructive deployment를 자동 생성하거나 실행하지 않는다.

## 개인용 최초 설정과 환경 점검

```bash
sfud setup
sfud doctor
sfud doctor --json
sfud doctor --check-url
```

`setup`은 서버의 대화형 터미널에서 실행한다. 내 PC 전용 또는 원격 개인용을 선택하고 수신 주소·포트·개인용 데이터 경로를 설정한다. 원격 개인용의 비밀번호는 숨김 입력과 재입력으로 확인한다. 저장 전 파일·모드·주소와 환경변수 우선 항목을 표시하며 비밀값은 표시하지 않는다. 저장 확인을 취소하면 설정 파일을 생성하지 않는다. 파이프·CI 등 비대화형 실행은 입력을 기다리지 않고 안내와 종료 코드 2를 반환한다.

기존 사용자별 모드나 DB를 개인용으로 전환하지 않는다. 기존 공유·호환 암호화 키와 비밀 파일의 기존 줄을 보존한다. 새 키는 선택한 데이터 경로가 비어 있고 기존 DB도 없을 때만 생성 여부를 묻는다. 기존 DB가 있으면 키를 복구해야 하며 새 키를 만들지 않는다. 실행 중인 DB의 미체크포인트 WAL이 있으면 서버 종료 후 재점검하거나 별도 빈 데이터 경로를 선택한다.

원격 개인용 시작은 `sfud ui --allow-remote --no-open`이다. 홈 설정에 원격 수신 주소를 저장했어도 `--allow-remote`가 필요하다. 프록시 사용을 선택하면 공개 http(s) Origin과 실제 프록시 IP/CIDR을 함께 설정한다.

`doctor`는 홈 설정·비밀 파일·데이터 경로를 생성하거나 수정하지 않고 도구 버전, 파일 권한, 모드·프록시 정합성, 데이터 접근 권한과 OAuth 콜백을 점검한다. Node 22.19.0 이상과 Salesforce CLI v2가 지원 기준이며 Git 최소 버전은 별도 지정하지 않는다. 종료 코드는 0(실패 없음, 경고 가능), 1(점검 실패), 2(명령 사용 또는 실행 오류)다. `--json`은 stdout에 단일 JSON 결과를 출력한다.

URL은 기본적으로 계산 결과만 표시한다. `--check-url`에서만 서버에서 HEAD 요청을 보내며 리디렉션을 따라가지 않는다. 서버가 HTTP 응답을 받았다는 사실과 외부 브라우저·프록시 접근 성공은 다르다. 전체 인터페이스 수신 주소(`0.0.0.0`, `::`)를 접속 URL로 사용하지 않는다. 개인용 Salesforce OAuth는 서버의 로컬 콜백 포트(기본 1717, 현재 DX 프로젝트의 `oauthLocalPort` 설정 우선)를 사용하므로 원격 서버에선 해당 포트의 SSH 터널이 필요하다.
