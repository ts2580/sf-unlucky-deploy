# sf-unlucky-deploy 코드 리뷰 후속 작업 계획

- 원문: `docs/sf-unlucky-deploy-code-review.md`
- 분석 기준: `main@30e82862fc52e017b4de77ef335f4f0c6f39c958` (`v0.2.0`)
- 분석일: 2026-09-03
- 목적: 코드 리뷰에서 제시된 개선점을 실제 코드에 대조하고, 구현 순서와 완료 조건을 확정한다.

## 결론

리뷰에서 제기한 16개 항목은 모두 개선 가치가 있다. 특히 직접 배포 조건, Salesforce 원격 상태와
로컬 상태의 분리, 중복 배포 방지, org identity 고정은 실제 배포 결과에 영향을 줄 수 있다.

다만 다음 항목은 원문의 우선순위나 해결 방법을 보정한다.

- SQLite 트랜잭션 혼재는 단순 저장소 개선이 아니라 배포 상태 정합성 문제이므로 최우선 범위에 포함한다.
- target alias가 다른 org를 가리킬 수 있는 문제는 영향이 크므로 P1이 아닌 P0로 취급한다.
- `sf --json` 출력은 마지막 일부만 남기면 JSON 파싱이 불가능하므로, 크기 초과 시 실패하거나 임시 파일과
  streaming parser를 사용하는 방식으로 제한한다.
- 디렉터리 checksum은 모든 파일을 동시에 보관하지 않고 파일 하나씩 읽는다. streaming 전환은 필요하지만
  현재 메모리 문제의 우선 원인은 대형 diff 생성과 상세 JSON의 중복 저장·조회다.
- 로그인 제한은 성공 시 IP 기록을 단순히 남기는 방식으로 수정하지 않는다. 성공 요청까지 count하는 현재
  구조를 먼저 실패 기반 기록 방식으로 변경해야 한다.
- SBOM은 구성 추적 수단이지 설치 재현성 보장 수단이 아니다. 배포 패키지 재현성은
  `npm-shrinkwrap.json`을 중심으로 해결한다.

## 수정된 우선순위

| 우선순위 | 작업 | 핵심 위험 |
|---|---|---|
| P0 | 직접 배포 test level 계약 통일 | 선택과 다른 테스트 수준으로 실제 배포 |
| P0 | SQLite 접근 직렬화 | 무관한 쓰기의 동반 commit·rollback |
| P0 | Salesforce 원격 상태와 로컬 저장 상태 분리 | 성공한 배포를 실패로 오인 |
| P0 | 직접 배포 idempotency | 재시도·응답 유실에 따른 중복 배포 |
| P0 | immutable org identity 검증 | 같은 alias가 가리키는 다른 org에 배포 |
| P1 | reconciliation과 graceful shutdown | 종료 후 원격 작업 상태 방치 |
| P1 | wait·deadline·프로세스 상한 통합 | 정상 작업 강제 종료 또는 자원 고갈 |
| P1 | 작업 summary와 상세 artifact 분리 | 목록 조회만으로 DB·메모리 급증 |
| P1 | reverse proxy와 인증 제한 정책 보강 | 공유 IP 차단, 제한 우회, 잘못된 보안 판정 |
| P2 | 업로드 quota·Windows 경로 보강 | 임시 저장소 고갈과 플랫폼별 경로 오판 |
| P2 | local metadata type과 Apex 후보 계약 수정 | 지원한다고 안내한 웹 기능 사용 불가 |
| P2 | XML semantic 비교 확장 | metadata type별 false positive·negative |
| P2 | UI/API 구조 분리와 CI matrix | 계약 누락과 플랫폼 회귀 |

## 구현 원칙

1. 실제 배포 경로의 동작을 먼저 고정하고 UI 리팩터링은 이후에 진행한다.
2. Salesforce에 제출된 작업은 로컬 저장 오류만으로 `FAILED` 처리하지 않는다.
3. payload checksum과 org identity를 별개의 검증값으로 관리한다.
4. 같은 요청의 재전송과 사용자가 의도한 새 배포를 구분한다.
5. 상태 복구는 Salesforce report 조회만 수행하며 자동 재배포하지 않는다.
6. 모든 DB write는 하나의 직렬화 정책 또는 트랜잭션 전용 connection을 거친다.
7. 기능별 변경과 회귀 테스트를 같은 작업 단위로 완료한다.

## 작업 1. 직접 배포 test level 계약 통일

### 변경 내용

- `CreateDirectDeploymentInput`이 `testLevel`을 포함하도록 변경한다.
- `/api/v1/deployments/direct` route에서 검증한 `testLevel`을 서비스로 전달한다.
- UI의 직접 배포 요청에도 현재 선택된 `testLevel`을 포함한다.
- dry-run과 직접 배포에서 같은 test plan resolver를 사용한다.
- `skipDryRun`은 사용자가 `NoTestRun`을 명시적으로 선택한 경우에만 허용한다.

### 정책

```text
auto
  명시 테스트 있음        -> RunSpecifiedTests
  suffix 테스트 발견      -> RunSpecifiedTests
  테스트를 찾지 못함      -> RunLocalTests

RunSpecifiedTests
  테스트 1개 이상 필수

NoTestRun
  사용자가 명시한 경우에만 check-only 생략

그 외 test level
  선택값을 변경하지 않고 check-only와 실제 배포에 동일 적용
```

### 대상 파일

- `ui/src/App.tsx`
- `src/web/server/deployment-routes.ts`
- `src/deploy/dry-run-service.ts`
- `src/deploy/test-plan.ts`
- `test/dry-run-api.test.ts`
- `e2e/ui.spec.ts`

### 완료 조건

- `RunLocalTests`, `RunAllTestsInOrg`, `RunRelevantTests`가 직접 배포에서도 유지된다.
- `auto`가 테스트 미발견 시 `NoTestRun`으로 내려가지 않는다.
- direct 요청, 저장된 test plan, check-only, 실제 deploy 명령의 test level이 일치한다.

## 작업 2. SQLite 접근 직렬화

### 변경 내용

- 모든 DB query와 write를 공통 `DatabaseExecutor`를 통해 실행한다.
- transaction callback에는 transaction 전용 handle을 전달한다.
- transaction 실행 중 원본 connection을 외부 repository가 직접 사용하지 못하게 한다.
- 다음 직접 write를 우선 이전한다.
  - Salesforce progress와 deployment result 저장
  - comparison running/recovery 상태 저장
  - session revoke·정리
  - startup recovery
- transaction과 단일 write가 동일한 순서 정책을 사용하도록 한다.

### 대상 파일

- `src/storage/transaction.ts`
- `src/storage/sqlite-store.ts`
- `src/deploy/deployment-job-repository.ts`
- `src/compare/comparison-job-repository.ts`
- `src/auth/auth-service.ts`
- `src/storage/user-repository.ts`
- `src/storage/user-settings-repository.ts`

### 완료 조건

- transaction A 실행 중 시작한 독립 update B가 A의 rollback에 포함되지 않는다.
- repository의 상태 전이와 audit 기록은 원자적으로 유지된다.
- 동시 요청 테스트가 반복 실행에서도 결정적으로 통과한다.

## 작업 3. Salesforce 원격 상태와 로컬 저장 상태 분리

### 변경 내용

- Salesforce deployment ID를 받은 즉시 작은 독립 write로 저장한다.
- 원격 상태와 artifact 저장 상태를 구분할 수 있는 필드를 추가한다.
- progress 저장 실패가 Salesforce report polling을 중단하지 않도록 한다.
- 최종 원격 성공을 확인한 뒤 상세 JSON 저장이 실패하면 원격 성공 상태를 보존하고 경고를 기록한다.
- deployment ID 수신 후 최종 상태를 확인하지 못한 오류는 `RECONCILE_REQUIRED`로 전환한다.
- DB lock·DB closed 상황에서도 deployment ID를 잃지 않도록 제한된 재시도와 `0600` 비상 journal을 검토한다.

### 권장 상태 정보

```text
local status
  QUEUED | SUBMITTING | DEPLOYING | SUCCEEDED | FAILED | RECONCILE_REQUIRED

remote status
  NOT_SUBMITTED | SUBMITTED | RUNNING | SUCCEEDED | FAILED | UNKNOWN

persistence warning
  progress 또는 상세 artifact 저장 실패 내용
```

`SUCCEEDED_WITH_WARNING`을 별도 상태로 추가하거나 `SUCCEEDED + persistenceWarning`으로 표현할 수 있다.
기존 UI와 상태 전이 복잡도를 줄이려면 후자를 우선 검토한다.

### 완료 조건

- progress 저장 실패 후에도 report polling이 계속된다.
- Salesforce 성공 후 artifact 저장 실패가 `FAILED`로 기록되지 않는다.
- deployment ID가 존재하는 불명확한 실패는 재확인 가능한 상태로 남는다.
- UI가 원격 결과와 로컬 저장 경고를 구분해 표시한다.

## 작업 4. 직접 배포 idempotency

### 변경 내용

- `/api/v1/deployments/direct`에 `Idempotency-Key`를 도입한다.
- UI는 실제 배포 버튼을 누를 때 UUID를 만들고 결과가 확정될 때까지 같은 key를 재사용한다.
- DB에 `created_by`, `client_request_id`, `request_hash`를 저장하고 unique index를 추가한다.
- 동일 key와 동일 hash 요청에는 기존 job을 반환한다.
- 동일 key와 다른 hash 요청에는 `409 IDEMPOTENCY_CONFLICT`를 반환한다.
- HTTP 요청 중단은 Salesforce 작업 취소가 아님을 UI에 반영한다.

### 완료 조건

- 같은 key로 동시에 두 번 요청해도 job과 Salesforce 제출은 각각 하나다.
- 응답 유실 후 재시도하면 기존 job ID를 돌려준다.
- 새 key를 사용한 명시적 재배포는 허용된다.

## 작업 5. immutable org identity

### 변경 내용

- workspace org 모델에 `username`, `orgId`, 필요한 경우 `instanceUrlHash`를 추가한다.
- dry-run·직접 배포 job 생성 시 source와 target identity snapshot을 저장한다.
- Salesforce 작업 제출 직전에 alias를 다시 조회하고 저장된 identity와 비교한다.
- alias는 같지만 org ID가 다르면 작업을 제출하지 않는다.
- dry-run 승인 유효시간을 추가하고 만료된 dry-run은 다시 실행하도록 한다.
- UI의 확인 영역에 alias와 함께 username, 마스킹한 org ID를 표시한다.

전체 metadata fingerprint는 1차 범위에서 제외한다. 비용이 크고 조회와 배포 사이 변경을 완전히 막을 수
없으므로, immutable identity와 dry-run 만료 정책을 먼저 적용한다.

### 완료 조건

- dry-run 이후 alias가 다른 org로 재매핑되면 실제 배포가 차단된다.
- queue 대기 중 identity가 바뀐 직접 배포도 제출 전에 차단된다.
- identity 불일치 사유와 확인된 값이 민감정보 없이 audit에 남는다.

## 작업 6. reconciliation과 graceful shutdown

### 변경 내용

- 종료 시작 시 신규 comparison·deployment job 접수를 중단한다.
- 제한시간 동안 현재 작업의 ID 저장과 queue drain을 기다린다.
- 제한시간이 지나면 제출된 작업은 `RECONCILE_REQUIRED`로 기록한다.
- workspace와 DB는 queue 정리 이후 닫는다.
- `POST /api/v1/deployment-jobs/:id/reconcile`을 추가한다.
- reconcile은 저장된 identity를 확인한 후 deployment ID로 report만 조회한다.
- 서버 시작 시 read-only 자동 reconciliation을 선택적으로 수행한다.
- reconciliation은 절대로 자동 재배포하지 않는다.

### 완료 조건

- 실행 중 서버를 종료해도 DB closed 오류가 정상 작업을 `FAILED`로 만들지 않는다.
- 재시작 후 저장된 Salesforce ID로 성공·실패 상태를 확정할 수 있다.
- 진행 중인 원격 작업은 `RECONCILE_REQUIRED`를 유지한다.
- 모든 수동 reconciliation이 audit에 기록된다.

## 작업 7. Salesforce 프로세스와 deadline 관리

### 변경 내용

- `--wait`에서 process deadline을 만드는 공통 함수를 추가한다.
- compare·deploy snapshot retrieve와 deploy report가 동일한 deadline 정책을 사용한다.
- report command timeout을 전체 남은 시간 이하로 제한한다.
- polling 간격에 상한이 있는 backoff를 적용한다.
- `SfRunOptions`에 `AbortSignal`과 출력 크기 제한을 추가한다.
- timeout 시 `SIGTERM -> grace period -> 강제 종료`를 수행한다.
- 가능한 플랫폼에서 child process tree까지 종료한다.

`runJson()`은 완전한 JSON이 필요하므로 출력 일부를 잘라 파싱하지 않는다. 허용 크기를 넘으면
명시적인 `SF_OUTPUT_TOO_LARGE` 오류를 반환하거나 권한이 제한된 임시 파일로 stream한다.

### 완료 조건

- `waitMinutes=60`인 retrieve의 process timeout이 60분보다 짧지 않다.
- 남은 시간이 10초인 상태에서 5분짜리 report timeout을 시작하지 않는다.
- `SIGTERM`을 무시하는 child가 grace period 뒤 종료된다.
- 출력 제한 초과가 OOM 대신 정해진 오류로 끝난다.

## 작업 8. summary와 상세 artifact 분리

### 1차 범위

- `listRecentSummary()` projection query를 추가해 대형 JSON column을 읽지 않는다.
- 목록 API는 summary column만 반환한다.
- comparison·deployment summary count를 별도 column에 저장한다.
- run 디렉터리와 파일은 `0700`, `0600` 권한을 명시한다.

### 2차 범위

- 상세 comparison과 Salesforce 원문 응답을 압축 artifact로 분리한다.
- component server-side pagination API를 추가한다.
- 파일별 diff 크기와 변경 라인 수 상한을 둔다.
- run 보존 기간, 전체 디스크 quota, snapshot 전 여유 공간 검사를 추가한다.
- checksum을 streaming hash로 변경한다.

### 완료 조건

- 최근 작업 50개 조회 시 comparison·dry-run·deployment 상세 JSON을 parse하지 않는다.
- 대형 결과에서도 목록 응답 크기가 summary 크기에 비례한다.
- 상세 artifact 접근 권한과 경로 containment가 검증된다.

## 작업 9. reverse proxy와 인증 정책

### 변경 내용

- 허용한 proxy IP 또는 CIDR만 `trustProxy`로 설정한다.
- 애플리케이션에서 `X-Forwarded-Proto`를 직접 신뢰하지 않고 `request.protocol`을 사용한다.
- `publicOrigin` 설정으로 Origin의 scheme과 host를 함께 검증한다.
- login limiter를 `허용 여부 확인 -> 인증 실패 시 증가` 구조로 변경한다.
- IP와 account 제한의 window와 초기화 정책을 분리한다.
- bootstrap endpoint에도 제한을 적용한다.
- cookie parsing을 예외 안전하게 바꾸거나 `@fastify/cookie`를 사용한다.
- 보안 header를 앱 또는 공식 reverse proxy 설정에 추가한다.
- 공개 health와 인증된 diagnostics 응답을 분리한다.

### 완료 조건

- proxy 뒤 서로 다른 client IP가 같은 제한 bucket을 공유하지 않는다.
- 정상 로그인 반복이 IP 실패 횟수를 증가시키지 않는다.
- 자신의 정상 로그인으로 다른 계정에 대한 IP 실패 기록을 초기화할 수 없다.
- 잘못된 `%` cookie가 500 대신 비인증 응답으로 처리된다.

## 작업 10. 업로드 저장소 보강

- 금지 디렉터리 비교를 대소문자 비의존적으로 처리한다.
- 최종 `targetPath`의 resolved containment를 재검증한다.
- Windows 예약명, ADS 구분자, trailing dot·space를 거부한다.
- 사용자별·서버 전체 업로드 quota를 추가한다.
- 서버 시작 시 소유자·권한·mtime을 검증한 stale upload scavenger를 실행한다.
- `findManifests()`는 `ENOENT`만 빈 목록으로 처리하고 나머지 오류는 전달한다.

Windows를 공식 지원하지 않는다면 예약명 검사는 P2로 유지하되, quota와 stale 정리는 플랫폼과 무관하게
먼저 적용한다.

## 작업 11. 비교 기능 정확성과 계약 보완

### local metadata type

- `discoverLocalMetadataTypes()`를 공통 서비스로 추출한다.
- org는 metadata registry 조회, local은 package directory 탐색 결과를 사용한다.
- local과 org 결과를 합집합으로 반환한다.
- 연결된 org가 없는 local-to-local 웹 비교 테스트를 추가한다.

### Apex 후보

- API가 desired source의 전체 ApexClass 후보를 반환한다.
- 각 후보에 `matchesConfiguredSuffix`를 포함한다.
- UI는 suffix 일치 항목을 먼저 표시하되 나머지를 숨기지 않는다.
- 직접 입력은 후보 목록 존재 여부와 독립적으로 유지한다.

### XML semantics

- metadata type과 XML path별 identity·ordered 정책 registry를 도입한다.
- Profile, PermissionSet, Layout처럼 영향이 큰 타입부터 fixture를 추가한다.
- semantic equality와 raw hash 차이를 UI와 보고서에서 구분한다.
- 알려지지 않은 타입은 generic 비교임을 warning에 표시한다.

## 작업 12. UI/API 구조와 CI

### UI/API

- 배포 API request·response schema부터 공유 모듈로 옮긴다.
- Fastify runtime validation과 UI 타입이 같은 schema에서 나오게 한다.
- 공통 API client에서 CSRF, 오류 parsing, 401, timeout, abort, idempotency key를 처리한다.
- `App.tsx`는 deployment, comparison, auth, admin 순서로 기능 단위 분리한다.
- 한 번에 전체 파일을 재작성하지 않고 기능별 회귀 테스트와 함께 분리한다.

### CI와 패키지

- Linux Node 24에서 전체 verify와 Playwright를 유지한다.
- Linux Node 20에서 최소 지원 버전 unit·build를 실행한다.
- Windows Node 20 또는 24에서 process·path·upload·sqlite/package smoke를 실행한다.
- ESLint와 unused export 검사를 단계적으로 추가한다.
- GitHub Release tarball에 `npm-shrinkwrap.json`을 포함하고 설치된 dependency tree를 검증한다.
- SBOM은 재현성 해결책이 아니라 별도 공급망 가시성 산출물로 취급한다.

## 필수 회귀 테스트

| 범위 | 테스트 | 기대 결과 |
|---|---|---|
| test plan | 직접 배포 + `RunLocalTests` + tests 없음 | `RunLocalTests` 유지 |
| test plan | 직접 배포 + 명시적 `NoTestRun` | check-only 생략 |
| remote state | ID 수신 후 progress DB 저장 실패 | polling 지속, `FAILED` 금지 |
| remote state | 원격 성공 후 artifact 저장 실패 | 성공 보존과 저장 경고 표시 |
| idempotency | 같은 key·hash로 직접 배포 2회 | 같은 job 반환 |
| idempotency | 같은 key·다른 hash | 409 반환 |
| org identity | alias가 다른 org ID로 변경 | 제출 전 차단 |
| SQLite | transaction A 중 독립 update B 후 A rollback | B 유지 |
| shutdown | 실제 배포 polling 중 서버 종료 | ID 보존과 재확인 가능 |
| process | 60분 retrieve | process timeout 60분 이상 |
| process | child가 SIGTERM 무시 | grace 뒤 강제 종료 |
| storage | 대형 diff 목록 조회 | 상세 JSON 미조회·미파싱 |
| auth | 잘못된 cookie encoding | 500이 아닌 401 또는 정상 미인증 상태 |
| auth | proxy 뒤 서로 다른 client IP | 별도 rate-limit bucket |
| upload | 대소문자 금지 경로와 Windows 예약명 | 업로드 거부 |
| comparison | org 없는 local-to-local | metadata type 조회와 비교 가능 |
| Apex picker | suffix와 다른 ApexClass | 후보 목록 표시 |
| XML | 순서 비의미 배열 reorder | semantic change 없음 |

## 검증 게이트

각 작업 단위는 다음 검증을 통과해야 한다.

1. 관련 오류 주입 및 회귀 unit/API 테스트
2. `npm run check`
3. UI 변경이 있으면 전체 `npm run test:e2e`
4. package 또는 플랫폼 변경이 있으면 tarball 설치 smoke
5. 실제 Salesforce 검증은 사용자가 지정한 target alias를 mutation 직전에 다시 확인
6. 실제 배포 검증은 명시적인 테스트 수준과 지정 테스트를 사용하고 deployment ID·컴포넌트·테스트
   결과를 함께 확인

## 작업 단위 제안

변경은 다음 feature 크기로 나눈다.

1. 직접 배포 test level 계약과 회귀 테스트
2. SQLite executor와 동시성 테스트
3. 원격 상태 분리와 persistence failure injection
4. idempotency와 immutable org identity
5. reconciliation과 graceful shutdown
6. process deadline·출력·종료 상한
7. summary query와 artifact 저장 구조
8. proxy/auth 및 upload hardening
9. local metadata·Apex 후보·XML semantics
10. UI/API 분리와 CI matrix

각 단위는 별도 작업 브랜치에서 구현하고 `canary` 대상 Pull Request로 검증한다. `main`, `canary`에는
직접 push하지 않으며 실제 병합은 사용자가 수행한다.

## 이번 계획에서 제외하는 항목

- reconciliation 중 자동 재배포
- 모든 Salesforce metadata type의 semantic 규칙 일괄 구현
- target 전체 metadata fingerprint를 이용한 강제 잠금
- DB 또는 artifact 저장 실패를 로그만 남기고 무시하는 처리
- 테스트 없이 UI 전체를 한 번에 분리하는 대규모 리팩터링
- SBOM만으로 dependency 재현성이 확보됐다고 판단하는 것
