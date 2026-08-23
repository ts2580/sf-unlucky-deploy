# Salesforce 메타데이터 비교·배포 계획

- 작성일: 2026-08-22
- 상태: `IN_PROGRESS`
- 대상 저장소: `sf-unlucky-deploy`
- 예정 원격: `https://github.com/ts2580/sf-unlucky-deploy.git`
- 구현 언어: TypeScript (Node.js)

## 1. 목표

Salesforce 메타데이터 소스를 동일한 방식으로 스냅샷화하고 비교·검증·배포한다.

지원할 소스는 다음과 같다.

1. 인증된 Salesforce org
2. 현재 저장소 또는 지정 경로의 Salesforce DX 프로젝트

최종적으로 다음 흐름을 모두 지원한다.

- org ↔ org 메타데이터 비교
- local ↔ org 메타데이터 비교
- local ↔ local 메타데이터 비교
- org → org 검증 및 배포
- local → org 검증 및 배포

비교는 컴포넌트의 유무뿐 아니라 실제 내용 차이와 변경 전·후 값까지 보여준다.

## 2. 핵심 원칙

### 2.1 동일한 배포 범위

모든 비교와 배포는 하나의 명시적인 `package.xml`을 범위 계약으로 사용한다. 양쪽 소스를 서로 다른 범위로 조회하지 않는다.

### 2.2 동일한 중간 형식

org와 local을 모두 Metadata API 형식의 staging 디렉터리로 변환한다.

- org: `sf project retrieve start --target-metadata-dir ... --unzip`
- local: `sf project convert source --manifest ... --output-dir ...`

이렇게 해야 Salesforce DX의 분해된 source 형식과 org retrieve 결과를 직접 비교할 때 생기는 구조 차이를 피할 수 있다.

### 2.3 비교한 결과물을 그대로 배포

비교 후 staging 디렉터리의 SHA-256을 기록하고, 실제 배포에도 동일한 staging 결과물을 사용한다. 비교한 패키지와 배포한 패키지가 달라지는 것을 허용하지 않는다.

### 2.4 안전한 기본값

- 배포 명령의 기본 동작은 `dry-run`이다.
- 실제 반영에는 `--execute`가 필요하다.
- diff만으로 대상 org의 메타데이터를 자동 삭제하지 않는다.
- 삭제는 별도의 destructive manifest와 명시적인 실행 절차로만 지원한다.
- Salesforce 인증 토큰과 인증 URL은 파일이나 로그에 기록하지 않는다.

## 3. CLI 사용안

도구의 임시 이름은 `sfud`로 둔다.

```bash
# org와 org 비교
sfud compare \
  --left org:dev \
  --right org:prod \
  --manifest manifest/package.xml

# 현재 로컬 프로젝트와 org 비교
sfud compare \
  --left local:. \
  --right org:prod \
  --manifest manifest/package.xml

# 두 로컬 프로젝트 비교
sfud compare \
  --left local:/path/to/project-a \
  --right local:/path/to/project-b \
  --manifest manifest/package.xml

# org에서 받아 대상 org에 검증 배포
sfud deploy \
  --from org:dev \
  --to prod \
  --manifest manifest/package.xml

# 로컬 프로젝트를 대상 org에 검증 배포
sfud deploy \
  --from local:. \
  --to prod \
  --manifest manifest/package.xml

# 검증 완료 후 실제 배포
sfud deploy \
  --from local:. \
  --to prod \
  --manifest manifest/package.xml \
  --execute
```

세부 출력 관련 옵션은 다음과 같이 둔다.

```text
--detail              모든 변경 상세를 터미널에 출력
--only-changed        동일한 컴포넌트는 출력하지 않음
--strict              형식 차이까지 엄격하게 비교
--fail-on-diff        차이가 있으면 종료 코드 1 반환
--report-dir <path>   리포트 저장 위치 지정
--json                터미널 대신 JSON 결과 출력
```

## 4. 비교 모델

### 4.1 컴포넌트 상태

각 메타데이터 컴포넌트를 다음 네 상태로 분류한다.

| 상태 | 의미 |
|---|---|
| `ADDED` | 오른쪽에만 존재 |
| `REMOVED` | 왼쪽에만 존재 |
| `MODIFIED` | 양쪽에 존재하지만 내용이 다름 |
| `IDENTICAL` | 양쪽에 존재하고 내용도 동일 |

방향은 항상 `left → right`로 표시한다. 따라서 오른쪽에 새로 나타난 항목은 `ADDED`, 왼쪽에서 사라진 항목은 `REMOVED`다. 리포트에는 각각 `RIGHT_ONLY`, `LEFT_ONLY`도 함께 기록해 방향 혼동을 막는다.

### 4.2 컴포넌트 식별

기본 키는 다음 조합이다.

```text
metadataType + fullName
```

번들 또는 보조 파일은 하나의 논리 컴포넌트로 묶는다.

- Apex 소스와 `-meta.xml`
- LWC 번들 내부의 JavaScript, HTML, CSS, XML
- Aura 번들 내부 파일
- Static Resource 본문과 `-meta.xml`
- ExperienceBundle 등 디렉터리 기반 메타데이터

알 수 없는 유형은 파일 경로 기반 비교로 안전하게 fallback한다.

### 4.3 내용 비교

#### XML 메타데이터

XML은 구조를 파싱하되 다음 규칙을 지킨다.

- BOM과 줄바꿈 차이는 제거한다.
- 들여쓰기와 XML attribute 순서는 의미 없는 차이로 취급한다.
- 자식 element의 순서는 유지한다.
- 반복 element는 가능한 경우 `fullName`, `name`, `field`, `object` 같은 식별자로 표시한다.
- 순서가 실제 의미를 가질 수 있는 Layout 등의 항목은 임의 정렬하지 않는다.

변경 내용은 경로와 이전값·새값으로 출력한다.

```text
MODIFIED  CustomObject  Order__c

  fields.Status__c.label
    - 주문 상태
    + 처리 상태

  fields.Status__c.required
    - false
    + true

  fields.Channel__c
    + element added
```

`--strict` 모드에서는 정규화 전후의 원문 차이도 별도로 탐지한다.

#### 텍스트 소스

Apex, JavaScript, HTML, CSS 등은 줄바꿈을 통일한 뒤 unified diff를 제공한다.

```diff
 public with sharing class OrderService {
-    private static final Integer RETRY_COUNT = 3;
+    private static final Integer RETRY_COUNT = 5;
 }
```

#### 바이너리

파싱할 수 없는 Static Resource 등의 바이너리는 다음 정보를 제공한다.

- SHA-256
- 파일 크기
- 왼쪽·오른쪽 체크섬

#### 번들

LWC와 Aura는 번들 상태와 내부 파일 상태를 함께 출력한다.

```text
MODIFIED  LightningComponentBundle  orderTable
  MODIFIED  orderTable.js
  IDENTICAL orderTable.html
  ADDED     orderTable.css
```

### 4.4 프로필과 권한

Profile과 PermissionSet은 manifest에 포함된 다른 메타데이터 범위에 따라 retrieve 결과가 달라질 수 있다. 다음 정책을 적용한다.

- 항상 같은 manifest로 양쪽을 조회한다.
- Profile/PermissionSet 리포트에 비교 범위가 부분적일 수 있음을 표시한다.
- object, field, Apex class, user permission 단위로 변경 내용을 그룹화한다.
- 조회되지 않은 권한을 `false`로 추정하지 않는다.

## 5. 결과물

기본 리포트 위치는 `.sfud/runs/<timestamp>/`로 한다.

```text
.sfud/runs/<timestamp>/
├── run.json
├── left/
├── right/
├── reports/
│   ├── summary.md
│   ├── summary.json
│   ├── content.diff
│   ├── report.html
│   └── checksums.json
└── logs/
    ├── test-plan.json
    ├── dry-run.json
    └── deploy.json
```

- `summary.md`: 사람이 읽는 변경 요약과 상세
- `summary.json`: CI와 후속 자동화가 사용하는 구조화된 결과
- `content.diff`: 전체 unified diff
- `report.html`: 브라우저에서 확인하는 self-contained 상세 리포트
- `checksums.json`: manifest와 staging payload의 무결성
- `run.json`: 실행 시각, 소스 종류, org 별칭, CLI/API 버전, 옵션

로그는 Salesforce CLI의 민감 키와 인증 URL을 제거한 뒤 저장한다.

## 6. 배포 흐름

### 6.1 org → org

```text
source org 인증 확인
  → manifest 범위 retrieve
  → staging 및 체크섬 생성
  → target org 현재 상태 retrieve
  → 상세 비교 리포트 생성
  → target org dry-run 배포
  → 검증 결과 저장
  → --execute인 경우 같은 staging payload 실제 배포
```

Salesforce에는 이 도구 관점의 직접 org-to-org 배포를 두지 않는다. 반드시 retrieve된 불변 staging payload를 경유한다.

### 6.2 local → org

```text
local DX 프로젝트 검증
  → manifest 범위 Metadata API 형식 변환
  → staging 및 체크섬 생성
  → target org 현재 상태 retrieve
  → 상세 비교 리포트 생성
  → target org dry-run 배포
  → 검증 결과 저장
  → --execute인 경우 같은 staging payload 실제 배포
```

### 6.3 Apex 테스트

다음 옵션을 Salesforce CLI에 명시적으로 전달한다.

```text
--test-level NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg|RunRelevantTests
--tests <class...>
```

Production 배포의 Salesforce 제약은 CLI 검증 결과를 그대로 따르며 우회하지 않는다.

## 7. 프로젝트 구조안

```text
sf-unlucky-deploy/
├── force-app/
│   └── main/default/
├── manifest/
│   └── package.xml
├── src/
│   ├── cli.ts
│   ├── commands/
│   │   ├── compare.ts
│   │   └── deploy.ts
│   ├── sources/
│   │   ├── org-source.ts
│   │   └── local-source.ts
│   ├── metadata/
│   │   ├── component-resolver.ts
│   │   ├── comparator.ts
│   │   ├── snapshot.ts
│   │   ├── text-diff.ts
│   │   └── xml-diff.ts
│   ├── reports/
│   │   ├── json.ts
│   │   ├── markdown.ts
│   │   └── terminal.ts
│   └── salesforce/
│       └── sf-runner.ts
├── test/
│   ├── fixtures/
│   ├── unit/
│   └── integration/
├── working/
├── package.json
├── sfdx-project.json
└── tsconfig.json
```

## 8. 기술 선택

### 런타임과 주요 라이브러리

- TypeScript
- Node.js
- `commander`: CLI 명령과 옵션
- `fast-xml-parser`: XML 구조 파싱
- `diff`: unified text diff
- `picocolors`: 터미널 상태 색상
- `vitest`: 단위·통합 테스트

`sf` 실행은 셸 문자열을 조립하지 않고 Node.js의 `child_process.spawn`에 인자 배열을 전달한다. 별칭, 경로, manifest 이름이 셸 명령으로 해석되지 않게 한다.

## 9. 오류 및 종료 코드

| 종료 코드 | 의미 |
|---|---|
| `0` | 명령 성공. 기본 비교에서는 차이가 있어도 성공 |
| `1` | `--fail-on-diff` 사용 시 차이 발견 또는 배포 검증 실패 |
| `2` | 사용법·설정·인증·retrieve 등 실행 오류 |

오류 메시지에는 다음을 포함한다.

- 실패 단계
- 실행 대상의 비민감 식별자
- 실행한 `sf` 하위 명령 종류
- Salesforce CLI가 반환한 오류 코드와 안전하게 정제한 메시지
- 생성된 로그 또는 리포트 경로

## 10. manifest 정책

초기 `manifest/package.xml`은 자주 사용하는 deployable metadata 유형으로 시작한다. 무조건 모든 메타데이터를 wildcard로 조회하지 않는다.

이후 다음 명령을 별도로 제공한다.

```bash
sfud manifest generate --from org:dev --output manifest/dev-full.xml
```

org에서 생성한 manifest는 검토 후 비교·배포에 사용하며, managed package와 retrieve 불가능한 유형은 별도 보고한다.

## 11. 테스트 계획

### 11.1 단위 테스트

- 동일 XML의 공백·줄바꿈·attribute 순서 차이
- XML 값 추가·삭제·수정
- 반복 element와 순서 변경
- Apex/LWC 텍스트 diff
- 바이너리 SHA-256 비교
- source/meta 파일과 번들 그룹화
- 경로와 org 별칭의 안전한 인자 전달
- 민감 정보 로그 제거

### 11.2 fixture 통합 테스트

- local ↔ local 동일 상태
- local ↔ local 추가·삭제·수정 혼합 상태
- mock `sf`를 사용한 org ↔ org snapshot
- retrieve 실패 시 fail-closed
- dry-run 실패 후 실제 배포 차단
- snapshot 생성 후 파일 변경 시 체크섬 불일치로 배포 차단

### 11.3 실제 org 검증

인증된 테스트 org가 준비된 뒤 작은 manifest로 검증한다.

1. ApexClass 1개 동일 상태
2. XML 값 1개 차이
3. 한쪽에만 존재하는 컴포넌트 1개
4. local → org dry-run
5. org → org dry-run
6. 리포트와 Salesforce CLI 결과 대조

실제 배포는 별도 승인 전까지 수행하지 않는다.

## 12. 구현 단계와 완료 조건

### Phase 0. 프로젝트 골격

- [x] Salesforce DX 프로젝트 생성
- [x] TypeScript CLI 골격 생성
- [x] `.sfud/` 및 인증 관련 파일 ignore
- [x] 공통 manifest 작성
- [x] 기본 테스트 실행 환경 구성

완료 조건: `sfud --help`와 테스트 명령이 로컬에서 성공한다.

진행 기록(2026-08-22): API 67.0 Salesforce DX 골격, TypeScript CLI, 공통 manifest와 테스트 실행 환경 구성 완료.

### Phase 1. 공통 snapshot

- [x] `org:<alias>` 파서와 org snapshot 구현
- [x] `local:<path>` 파서와 local snapshot 구현
- [x] staging root 정규화
- [x] manifest 및 payload 체크섬 기록
- [x] 민감 정보가 없는 실행 메타데이터 저장

완료 조건: mock org와 fixture local이 비교 가능한 동일 디렉터리 형식으로 생성된다.

### Phase 2. 상세 비교

- [x] 컴포넌트 유무 분류
- [x] XML 구조 비교와 경로별 이전값·새값
- [x] 텍스트 unified diff
- [x] 바이너리 체크섬 비교
- [x] 번들 단위 집계
- [x] terminal, Markdown, JSON, HTML 리포트

완료 조건: 유무와 내용 차이가 fixture 기대 결과와 정확히 일치한다.

### Phase 3. 검증·배포

- [x] org → org staging 배포
- [x] local → org staging 배포
- [x] 기본/명시적 `--dry-run` 및 명시적 `--execute`
- [x] `*_Test.cls` 자동 선택 및 test-level 전달
- [x] 비교 payload와 배포 payload의 체크섬 검증
- [x] 배포 결과 리포트

완료 조건: mock 환경에서 dry-run 실패가 실제 배포를 막고, 승인된 동일 payload만 배포된다.

### Phase 4. 실제 org 최소 검증

- [x] 두 org 인증 별칭 준비
- [x] 작은 manifest로 비교
- [x] local → org dry-run
- [x] org → org dry-run 실행 경로 확인
- [x] 구조화된 diff와 실제 메타데이터 대조

완료 조건: 실제 org에서 유무·내용 차이와 배포 검증 결과가 재현된다.

진행 기록(2026-08-22): 연결된 `stdOrg`(API 67.0)에서 ApexClass 5개를 같은 org끼리 비교해 동일 5건을 확인했다. 임시 로컬 Apex와 `_Test` 클래스를 target 기준 `ADDED` 2건으로 비교했고, `RunSpecifiedTests` 1건·실패 0건·커버리지 100%로 check-only 배포에 성공했다. 배포 후 Tooling API 조회 결과 임시 클래스는 0건이었다. org → org check-only도 소문자 `_test` 클래스(`Oauth2_test`) 자동 선택까지 확인했으며, 배포 대상 기존 클래스 4개의 테스트 커버리지 0% 때문에 Salesforce 검증 단계에서 거부됐다. 독립된 두 org 간 검증은 두 번째 별칭이 없어 남아 있다.

진행 기록(2026-08-23): `aladin` 별칭(API 67.0, Connected)을 두 번째 org로 확인했다. 단일 `BookInfoCache` manifest의 `stdOrg → aladin` 직접 비교에서 `REMOVED` 1건, 배포 전 target → source 비교에서 `ADDED` 1건을 실제 org 목록과 대조했다. 기본 `RunLocalTests` check-only는 `aladin`에 이미 존재하던 `refreshBook_1()` 참조 오류를 정확히 보고했고, `NoTestRun` check-only는 컴포넌트 1건·오류 0건으로 성공했다. 이후 Tooling API 조회에서 `aladin`의 `BookInfoCache`가 0건임을 확인해 실제 배포가 없었음을 검증했다.

### Phase 5. 저장소 정리

- [x] README 사용법 작성
- [x] CI에서 unit/fixture 및 Playwright 테스트 구성
- [x] 예정 원격을 `origin`으로 등록
- [x] 사용자 확인 후 초기 커밋 및 push

완료 조건: 새 환경에서 설치·테스트·비교 명령을 문서만 보고 재현할 수 있다.

진행 기록(2026-08-23): 실제 Salesforce CLI local ↔ local 변환·비교, mock org 비교·배포, Playwright 데스크톱·모바일 렌더링을 검증했다. `stdOrg`와 `aladin` 사이의 실제 메타데이터 비교, local → org 및 org → org check-only 배포도 검증했으며, GitHub Actions의 canary와 main 실행도 통과했다.

## 13. 첫 버전에서 제외할 범위

- Salesforce 데이터 레코드 비교
- diff만으로 destructive deployment 자동 생성·실행
- dependency API를 사용한 완전한 배포 의존성 추론
- managed package 내부 구현 비교
- org 설정 전체의 의미론적 동등성 판정
- 실제 org 인증 자동 생성 또는 인증 정보 저장

이 항목들은 초기 비교와 배포의 신뢰성을 확보한 뒤 별도 단계로 다룬다.

## 14. 구현 시작 전 확정된 결정

- TypeScript와 Node.js를 사용한다.
- org와 local을 같은 source 인터페이스로 취급한다.
- 양쪽에 같은 manifest를 적용한다.
- 컴포넌트 유무와 실제 내용 차이를 모두 출력한다.
- XML은 변경 경로와 이전값·새값을 제공한다.
- 비교한 staging payload를 그대로 배포한다.
- 배포 기본값은 dry-run이다.
- 삭제는 자동화하지 않는다.
- 원격 등록, 커밋, push는 구현과 별도로 사용자 확인 후 진행한다.
