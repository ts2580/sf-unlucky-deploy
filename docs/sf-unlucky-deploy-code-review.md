# sf-unlucky-deploy 코드 리뷰 및 개선점

- 대상 저장소: `ts2580/sf-unlucky-deploy`
- 검토 기준 브랜치: `main`
- 검토 기준 커밋: `30e82862fc52e017b4de77ef335f4f0c6f39c958`
- 검토 기준 버전: `v0.2.0`

## 검토 범위

리포지토리 구조, CLI·웹 실행 흐름, Salesforce CLI 호출, 비교·배포 상태 관리, SQLite, 인증, 업로드, UI, 테스트와 릴리스 구성을 정적으로 검토했다.

이번 검토에서는 `npm ci`, `npm run verify`, 실제 Salesforce CLI 연동 테스트를 실행하지 않았다. 따라서 아래 내용은 코드 경로를 기반으로 한 정적 분석 결과이며, 실제 부하·운영 환경에서 추가 검증이 필요하다.

# 전체 판단

현재 코드는 단순한 Salesforce 배포 스크립트 수준을 넘어 다음 안전장치를 갖추고 있다.

- `sf` 프로세스를 `shell: false`와 인자 배열로 실행해 셸 인젝션 가능성을 낮췄다.  
  소스: `src/salesforce/sf-client.ts`
- 요청마다 별도 Salesforce DX 작업 디렉터리를 만들고 종료 시 제거한다.
- Dry-run과 실제 배포 사이의 payload SHA-256을 다시 검사한다.
- 비밀번호는 `scrypt`, 세션·CSRF 토큰은 해시만 저장하며, Origin·CSRF·역할 검증과 마지막 관리자 보호가 구현되어 있다.  
  소스: `src/auth/auth-service.ts`, `src/web/server/auth-routes.ts`
- SQLite에 상태 전이, 승인, 감사 기록을 저장하고 `STRICT`, foreign key, WAL을 사용한다.  
  소스: `src/storage/sqlite-store.ts`, `src/storage/migrations.ts`
- 단위 테스트, API 테스트, Playwright, 패키지 설치 스모크 테스트까지 릴리스 파이프라인에 포함되어 있다.  
  소스: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

다만 현재 가장 큰 위험은 기능 부족이 아니라 **사용자가 선택한 조건과 실제 배포 동작의 불일치**, **Salesforce 외부 상태와 로컬 DB 상태의 불일치**, **중복 요청과 프로세스 장애 처리**다.

특히 아래 세 항목은 실제 배포 결과에 영향을 줄 수 있어 먼저 수정하는 것이 적절하다.

## 우선순위 요약

| 우선순위 | 문제 | 영향 | 예상 범위 |
|---|---|---|---|
| P0 | 직접 배포에서 선택한 test level이 무시됨 | 의도와 다른 테스트 또는 `NoTestRun` 배포 | 소~중 |
| P0 | Salesforce 작업 성공 후 로컬 DB 오류가 `FAILED`로 기록될 수 있음 | 성공한 배포를 실패로 오인하고 재배포 | 중~대 |
| P0 | 직접 배포 API에 idempotency가 없음 | 응답 유실·재시도 시 중복 배포 | 중 |
| P1 | `--wait 60`과 실제 프로세스 timeout 35분 불일치 | 정상 retrieve 중 강제 종료 | 소 |
| P1 | target을 alias로만 고정 | alias 변경 시 다른 org에 배포 가능 | 중 |
| P1 | SQLite 트랜잭션과 비트랜잭션 작업이 같은 연결에서 혼재 | 무관한 쓰기의 예상치 못한 commit/rollback | 중~대 |
| P1 | 전체 diff와 Salesforce 응답을 DB·API·파일에 중복 저장 | 메모리·DB·디스크 급증 | 대 |
| P1 | 종료 처리와 `RECONCILE_REQUIRED` 후속 기능 부족 | 외부 작업 진행 중 서버 종료 시 상태 방치 | 중 |
| P2 | reverse proxy, 쿠키 파싱, 로그인 제한 정책 | 원격 운영에서 오판·DoS·500 가능 | 중 |
| P2 | UI 단일 파일과 API 타입 중복 | 수정 영향 범위 및 회귀 위험 증가 | 대 |

---

# 1. 직접 배포에서 test level이 무시된다

현재 UI에서는 다음 수준을 선택할 수 있다.

- `auto`
- `RunSpecifiedTests`
- `RunLocalTests`
- `RunAllTestsInOrg`
- `RunRelevantTests`
- `NoTestRun`

그런데 `/api/v1/deployments/direct` 요청에는 `tests`만 전달되고 `testLevel`은 전달되지 않는다. 서버 route도 `testLevel`을 `createDirect()`에 넘기지 않는다.

소스:

- `ui/src/App.tsx`
- `src/web/server/deployment-routes.ts`

서비스에서는 직접 배포 수준을 다음과 같이 다시 결정한다.

```ts
const testLevel =
  tests.length > 0 ? 'RunSpecifiedTests' : 'NoTestRun';
```

그리고 테스트 이름이 없으면 `skipDryRun: true`로 실제 배포를 수행한다.

소스: `src/deploy/dry-run-service.ts`

따라서 사용자가 UI에서 `RunLocalTests` 또는 `RunAllTestsInOrg`를 선택해도 테스트 클래스 이름이 없으면 실제 동작은 다음과 같다.

```text
사용자 선택: RunLocalTests
실제 서버 동작: NoTestRun + check-only 생략
```

프로덕션에서 Salesforce가 `NoTestRun`을 거부하면 배포 실패로 끝나겠지만, 테스트가 필수가 아닌 변경이라면 사용자가 의도한 검증 없이 배포될 수 있다.

## 개선 방향

`CreateDirectDeploymentInput`에서 `testLevel`을 제거하지 말고 dry-run과 동일한 규칙으로 처리해야 한다.

```ts
export interface CreateDirectDeploymentInput extends CreateDryRunInput {
  targetConfirmation: string;
  confirmation: string;
}
```

직접 배포의 정책은 다음처럼 명시하는 것이 안전하다.

```text
auto
  ├─ 명시 테스트 있음 → RunSpecifiedTests
  ├─ staging에서 suffix 테스트 발견 → RunSpecifiedTests
  └─ 없음 → RunLocalTests

NoTestRun
  └─ 사용자가 명시적으로 선택한 경우에만 check-only 생략
```

최소한 UI가 현재 서버 정책을 유지하려면 직접 배포 시 선택 가능한 수준을 `RunSpecifiedTests`와 `NoTestRun`으로 제한해야 한다. 하지만 dry-run과 직접 배포의 규칙을 통일하는 편이 코드와 사용자 경험 양쪽에서 일관된다.

---

# 2. Salesforce 성공과 로컬 DB 실패를 구분하지 못한다

`runAsyncSalesforceDeployment()`는 Salesforce에 작업을 제출해 deployment ID를 받은 뒤 `onProgress` 콜백을 `await`한다.

소스: `src/deploy/salesforce-deployment.ts`

웹 서비스는 이 콜백에서 SQLite에 진행 상태를 저장한다.

```ts
onDeploymentProgress: async (progress) => {
  await this.jobs.recordSalesforceProgress(job.id, progress);
}
```

소스: `src/deploy/dry-run-service.ts`

`recordSalesforceProgress()`에서 DB lock, 디스크 부족, DB closed, 상태 충돌 등이 발생하면 예외가 그대로 Salesforce polling 루프 밖으로 전달된다.

소스: `src/deploy/deployment-job-repository.ts`

현재 `runAsyncSalesforceDeployment()`는 네트워크 오류나 timeout만 외부 상태 불명으로 처리한다. SQLite 오류는 일반 오류로 다시 던져지고, coordinator는 작업을 `FAILED`로 기록할 수 있다.

문제는 이미 Salesforce에 deployment가 제출됐다는 점이다.

```text
Salesforce 상태: 실제 배포 진행 중 또는 성공
로컬 상태: FAILED
사용자 판단: 실패했으니 다시 배포
결과: 중복 배포 가능
```

비슷한 문제는 실제 Salesforce 배포가 성공한 뒤 `recordDirectDeploymentArtifacts()`가 실패할 때도 발생한다. 배포 자체는 성공했지만 결과 JSON 저장이 실패했다는 이유로 전체 작업이 실패처럼 보일 수 있다.

## 개선 방향

외부 작업 상태와 로컬 저장 상태를 분리해야 한다.

```text
QUEUED
  → SUBMITTING
  → SUBMITTED(deploymentId)
  → REMOTE_RUNNING
  → REMOTE_SUCCEEDED | REMOTE_FAILED
  → ARTIFACTS_PERSISTED
```

다음 원칙이 필요하다.

1. Salesforce ID를 받은 순간 최소 상태를 먼저 저장한다.
2. `onProgress` 저장 실패가 Salesforce polling을 중단시키지 않게 한다.
3. deployment ID를 받은 뒤 최종 결과를 확인하지 못한 모든 오류는 `FAILED`가 아니라 `RECONCILE_REQUIRED`로 처리한다.
4. Salesforce 성공 확인 후 상세 아티팩트 저장만 실패했다면 `FAILED`가 아니라 `SUCCEEDED_WITH_WARNING` 또는 별도의 로컬 저장 오류 상태로 기록한다.
5. Salesforce 결과 ID와 최종 status를 작은 독립 트랜잭션으로 먼저 저장하고, 큰 JSON과 보고서는 후속 작업으로 저장한다.

예를 들어 콜백은 다음처럼 외부 상태 머신과 분리할 수 있다.

```ts
async function reportProgress(progress: SalesforceDeploymentProgress) {
  try {
    await jobs.recordSalesforceProgress(jobId, progress);
  } catch (error) {
    logger.error({ jobId, deploymentId: progress.deploymentId, error });
    // Salesforce polling은 계속한다.
  }
}
```

단순히 예외를 무시하는 것보다는 outbox나 `persistence_warning` 필드에 기록하는 편이 낫다.

---

# 3. 직접 배포 API에 중복 요청 방지가 없다

Dry-run 승인 배포는 `deployment_approvals.dry_run_job_id`의 unique 제약으로 같은 dry-run을 두 번 승인할 수 없게 되어 있다.

소스: `src/deploy/deployment-job-repository.ts`

하지만 직접 배포는 매 요청마다 새로운 UUID의 job을 생성한다. 요청 checksum을 계산하고 있지만 unique 제약이나 idempotency 식별자로 사용하지 않는다.

소스:

- `src/deploy/deployment-job-repository.ts`
- `src/deploy/dry-run-service.ts`

다음 상황에서 동일 배포가 두 번 큐에 들어갈 수 있다.

- 서버가 job 생성 후 응답을 보내기 전에 연결이 끊긴 경우
- reverse proxy 또는 API 클라이언트가 POST를 재시도한 경우
- 사용자가 다른 브라우저 탭에서 같은 요청을 보낸 경우
- UI가 응답을 받지 못해 다시 실행한 경우

큐가 단일 실행이어도 두 job이 차례로 모두 수행되므로 중복 방지가 되지 않는다.

또한 UI의 `AbortController.abort()`는 HTTP 응답 대기만 중단한다. 서버가 이미 job을 생성했다면 Salesforce 작업은 그대로 진행된다. UI에서는 현재 job을 잊어버릴 수 있지만 실행 기록에는 남게 된다.

## 개선 방향

배포 요청에 `clientRequestId` 또는 `Idempotency-Key`를 도입해야 한다.

```sql
ALTER TABLE deployment_jobs
ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX uq_deployment_request
ON deployment_jobs(created_by, client_request_id);
```

서버 정책은 다음과 같이 구성할 수 있다.

```text
같은 key + 같은 request hash
  → 기존 job 반환

같은 key + 다른 request hash
  → 409 IDEMPOTENCY_CONFLICT
```

UI는 버튼을 누르는 시점에 UUID를 생성하고, 성공 또는 명시적 실패가 확인될 때까지 동일한 key를 사용해야 한다.

실제 배포가 `QUEUED` 상태일 때만 취소 가능하게 하고, `DEPLOYING` 이후에는 “취소”가 아니라 “상태 추적 중단”으로 구분하는 것이 필요하다.

---

# 4. `--wait`와 실제 프로세스 timeout이 일치하지 않는다

CLI의 기본 `--wait`는 60분이다.

소스: `src/program.ts`

그러나 `ProcessSfClient`의 기본 timeout은 35분이다.

```ts
options.timeoutMs ?? 35 * 60 * 1000
```

소스: `src/salesforce/sf-client.ts`

비교 명령은 snapshot 생성 시 `wait + 여유시간`을 별도 프로세스 timeout으로 넘기지만, 배포 명령의 snapshot retrieve에는 같은 보정이 빠져 있다. 그 결과 `--wait 60`으로 요청한 retrieve가 35분을 넘으면 Salesforce에서는 정상 처리 중이어도 로컬 프로세스가 종료될 수 있다.

## 개선 방향

Salesforce wait와 프로세스 timeout을 각각 계산하지 말고 하나의 함수로 통일해야 한다.

```ts
function sfCommandTimeout(waitMinutes: number): number {
  return (waitMinutes + 2) * 60_000;
}
```

retrieve, manifest 생성, deploy start/report에서 모두 같은 정책을 사용해야 한다.

회귀 테스트에는 다음 검증을 추가해야 한다.

```ts
expect(retrieveCall.options.timeoutMs)
  .toBeGreaterThanOrEqual((waitMinutes + 1) * 60_000);
```

---

# 5. Salesforce 프로세스 관리에 메모리·종료 상한이 없다

현재 프로세스 실행기는 stdout과 stderr를 전부 `Buffer[]`에 보관한 후 한 번에 합친다.

```ts
const stdout: Buffer[] = [];
const stderr: Buffer[] = [];
```

출력 크기 제한이 없기 때문에 큰 Salesforce JSON 응답이나 반복적인 경고가 발생하면 Node 프로세스 메모리가 증가한다. timeout에서는 `SIGTERM`만 보내며, 프로세스가 종료하지 않을 경우 `SIGKILL` 단계나 프로세스 그룹 종료가 없다.

소스: `src/salesforce/sf-client.ts`

비동기 배포 상태 확인도 기본 1초마다 새로운 `sf project deploy report` 프로세스를 생성한다.

소스:

- `src/deploy/salesforce-deployment.ts`
- `test/salesforce-deployment.test.ts`

한 시간 동안 실행되면 최대 수천 번의 CLI 프로세스가 생성될 수 있다. 또한 전체 deadline 검사가 report 명령 뒤에 있으므로, 남은 시간이 거의 없더라도 최대 5분짜리 report 요청을 추가로 시작할 수 있다.

## 개선 방향

- stdout·stderr 각각 최대 바이트를 제한한다.
- 전체 출력 대신 마지막 N KB를 ring buffer에 유지한다.
- 전체 원문이 필요하면 `0600` 권한 로그 파일로 stream한다.
- timeout 시 `SIGTERM → grace period → SIGKILL` 순서로 종료한다.
- Unix에서는 프로세스 그룹, Windows에서는 child tree 종료를 처리한다.
- `AbortSignal`을 `SfRunOptions`에 추가한다.
- polling은 `1초 → 2초 → 5초 → 10초 → 15초` 정도로 backoff한다.
- report 명령 timeout은 전체 남은 시간보다 클 수 없게 한다.

```ts
const remainingMs = deadline - Date.now();
if (remainingMs <= 0) throw timeoutError;

await sfClient.runJson(args, {
  cwd,
  timeoutMs: Math.min(remainingMs, REPORT_MAX_TIMEOUT),
});
```

---

# 6. target org를 alias 문자열로만 고정한다

Workspace는 Salesforce org에서 alias, 이름, edition, 연결 상태를 추출하지만 job에는 `targetAlias`만 저장한다.

소스:

- `src/web/server/workspace-service.ts`
- `src/deploy/deployment-job-repository.ts`

승인 시에도 다음 두 값만 확인한다.

- dry-run 당시 payload checksum
- dry-run 당시 target alias

Salesforce CLI의 alias 매핑이 dry-run 이후 다른 org로 변경되면 문자열은 같지만 실제 배포 대상은 달라질 수 있다. 또한 alias가 유지되더라도 dry-run과 승인 사이에 target metadata가 변경될 수 있다.

Payload checksum은 source payload의 동일성만 보장하며 target org의 동일성이나 상태는 보장하지 않는다.

## 개선 방향

job에 다음 정보를 저장해야 한다.

```ts
interface OrgIdentity {
  alias: string;
  username: string;
  orgId: string;
  instanceUrlHash?: string;
}
```

실제 배포 직전에 다시 조회해 dry-run 당시 값과 비교해야 한다.

추가로 다음 정책을 두는 것이 적절하다.

- 승인 가능 시간: 예를 들어 dry-run 성공 후 30분 또는 1시간
- 승인 시 target org identity 재검증
- 실제 배포 직전 target metadata fingerprint 또는 최소 LastModified 기준 재검증
- source가 org인 경우 source org identity도 고정
- 승인 화면에는 alias뿐 아니라 org ID 일부와 username을 표시

---

# 7. SQLite 트랜잭션 경계가 완전히 직렬화되지 않는다

`runInImmediateTransaction()`은 `WeakMap<Database, Promise>`를 이용해 이 함수를 통해 시작한 트랜잭션끼리는 직렬화한다.

소스: `src/storage/transaction.ts`

하지만 같은 SQLite 연결에 대해 다음과 같은 메서드는 트랜잭션 helper 밖에서 직접 `database.run()`을 수행한다.

- 진행 상태 저장
- 배포 결과 저장
- 일부 session 작업
- 비교 결과 저장

예를 들어 `recordSalesforceProgress()`와 `recordDeploymentResult()`는 직접 update한다.

소스: `src/deploy/deployment-job-repository.ts`

SQLite 트랜잭션은 연결 단위이므로 다음 순서가 가능하다.

```text
요청 A: BEGIN IMMEDIATE
요청 A: await ...
요청 B: 직접 UPDATE
요청 A: ROLLBACK
```

이 경우 요청 B의 update가 요청 A 트랜잭션에 포함되어 함께 rollback될 가능성이 있다. 반대로 관계없는 update가 함께 commit될 수도 있다.

## 개선 방향

두 가지 중 하나로 통일해야 한다.

1. 모든 DB 접근을 단일 `DatabaseExecutor`를 통해 직렬화한다.
2. 트랜잭션마다 전용 connection을 사용하고 조회 connection을 분리한다.

더 안전한 형태는 transaction callback에 별도 handle을 전달하는 방식이다.

```ts
database.transaction(async (tx) => {
  await tx.run(...);
  await tx.run(...);
});
```

그리고 외부 코드가 transaction 중인 원본 connection을 직접 사용하지 못하게 해야 한다.

반드시 동시성 테스트를 추가해야 한다.

```text
트랜잭션 A 시작
비트랜잭션 update B 실행
A rollback
B가 유지되는지 검증
```

---

# 8. 서버 종료와 reconciliation 흐름이 완결되지 않는다

`SingleJobQueue`에는 idle 대기 기능이 있지만 서버의 `onClose`에서는 queue를 중지하거나 기다리지 않고 workspace와 DB를 바로 닫는다.

소스:

- `src/deploy/single-job-queue.ts`
- `src/web/server/app.ts`

따라서 실제 배포 중 종료 신호를 받으면 다음 일이 가능하다.

```text
Salesforce 작업: 계속 진행
로컬 polling: DB closed 오류
업로드 workspace: 삭제
로컬 job: 다음 시작 시 RECONCILE_REQUIRED
```

재시작 시 실행 중이던 job을 `RECONCILE_REQUIRED`로 바꾸는 코드는 있지만, 해당 deployment ID를 다시 조회해 상태를 확정하는 API나 UI 동작은 현재 route에서 확인되지 않는다.

소스:

- `src/deploy/deployment-job-repository.ts`
- `src/web/server/deployment-routes.ts`

즉 `RECONCILE_REQUIRED`는 상태 이름은 존재하지만 실제 운영 절차는 아직 완결되지 않았다.

## 개선 방향

종료 순서는 다음과 같아야 한다.

```text
1. 신규 job 접수 중단
2. QUEUED job을 유지하거나 명시적으로 취소
3. 실행 중인 job의 Salesforce ID 저장 확인
4. 제한시간 동안 queue drain
5. 남은 job을 RECONCILE_REQUIRED로 기록
6. workspace와 DB 종료
```

다음 reconciliation endpoint도 필요하다.

```text
POST /api/v1/deployment-jobs/:id/reconcile
```

동작은 다음과 같다.

1. 저장된 immutable target identity 확인
2. Salesforce deployment ID로 report 조회
3. 성공이면 `SUCCEEDED`
4. 실패이면 `FAILED`
5. 아직 진행 중이면 `RECONCILE_REQUIRED` 유지
6. 모든 조작을 감사 로그에 기록

가능하면 서버 시작 시 자동 reconciliation을 한 번 수행하는 편이 낫다.

---

# 9. 대형 metadata에서 DB·메모리·HTTP 응답이 동시에 증가한다

현재 파일 checksum은 전체 파일을 `readFile()`로 읽는다. 디렉터리 checksum도 모든 파일을 순차적으로 메모리에 읽는다.

소스: `src/core/files.ts`

비교기는 양쪽 파일 전체를 읽고 unified diff 전체를 생성한다. XML 변경 목록도 모두 메모리에 유지한다.

소스: `src/metadata/comparator.ts`

그 결과는 다시 다음 형태로 중복된다.

- `summary.json`
- `summary.md`
- `content.diff`
- `report.html`
- SQLite `comparison_result_json`
- SQLite `dry_run_result_json`
- SQLite `deployment_result_json`
- API 상세 응답

소스:

- `src/reports/writer.ts`
- `src/deploy/deployment-job-repository.ts`
- `src/web/server/deployment-routes.ts`

특히 `listRecent()`는 `SELECT *`로 최근 job을 읽은 다음 상세 JSON 전체를 `JSON.parse()`한다. 이후 목록 API는 상세를 버리고 summary만 반환한다. 즉 대시보드에서 최근 작업 50개를 표시하기 위해 대형 diff와 Salesforce 원문 결과를 모두 DB에서 읽어올 수 있다.

UI의 20개 단위 pagination도 서버 pagination이 아니라 이미 전달받은 `components` 배열을 slice하는 구조다. 네트워크와 서버 메모리 절감 효과는 없다.

## 개선 방향

저장 모델을 summary와 artifact로 분리해야 한다.

```text
deployment_jobs
  - status
  - source/target identity
  - summary counts
  - test result summary
  - artifact paths
  - checksums

run artifact
  - comparison-details.json.gz
  - salesforce-result.json.gz
  - report.html
```

API도 나누는 것이 적절하다.

```text
GET /deployment-jobs
GET /deployment-jobs/:id
GET /deployment-jobs/:id/components?page=1&size=50
GET /deployment-jobs/:id/components/:key/files
```

추가로 다음 상한이 필요하다.

- unified diff 파일당 최대 크기
- 변경 라인 최대 수
- API 응답 최대 컴포넌트 수
- 상세 결과 gzip
- 실행 결과 보존 기간·전체 디스크 quota
- 업로드 사용자별·전체 quota
- snapshot 시작 전 여유 디스크 검사

현재 run artifact에는 Salesforce source code와 설정 정보가 포함될 수 있는데 CLI 경로 생성과 일반 JSON 쓰기는 명시적인 `0700`/`0600`을 사용하지 않고 OS umask에 의존한다.

CLI와 명시적 report 경로에서도 파일 권한을 강제하는 것이 필요하다.

---

# 10. reverse proxy 처리와 로그인 제한 정책을 정리해야 한다

Fastify 생성 시 `trustProxy`가 설정되어 있지 않지만 HTTPS 판정은 `X-Forwarded-Proto`를 직접 신뢰한다.

소스:

- `src/web/server/app.ts`
- `src/web/server/auth-routes.ts`

이 구조에서는 reverse proxy 환경에서 다음 문제가 생긴다.

- `request.ip`에는 실제 클라이언트가 아니라 reverse proxy 주소가 들어갈 수 있다.
- 모든 사용자가 하나의 IP 로그인 제한을 공유해, 5회 실패로 전체 사용자의 로그인을 막을 수 있다.
- 반대로 직접 접속이 가능한 환경에서는 사용자가 임의의 `X-Forwarded-Proto: https`를 보내 Secure cookie 여부에 영향을 줄 수 있다.
- UI는 서버 bind host만 보고 “로컬 전용” 여부를 판단하므로 localhost로 bind한 뒤 reverse proxy로 공개해도 로컬 전용으로 표시될 수 있다.

로그인 성공 시 IP key와 account key를 모두 초기화한다. 유효한 계정 하나를 가진 사용자는 성공 로그인으로 IP 제한을 계속 초기화한 뒤 다른 계정을 시도할 수 있다.

수동 cookie parser의 `decodeURIComponent()`는 잘못된 `%` 문자열에서 예외를 던질 수 있으므로 변조된 cookie 하나로 인증 API가 500을 반환할 수 있다.

## 개선 방향

- `trustProxy`에 허용할 reverse proxy IP 또는 CIDR을 명시한다.
- 이후 `request.ip`, `request.protocol`만 사용한다.
- `X-Forwarded-*`를 애플리케이션에서 직접 해석하지 않는다.
- `publicOrigin`을 설정해 Origin의 scheme과 host를 모두 검사한다.
- IP 제한과 account 제한을 별도 정책으로 유지한다.
- 성공 시 account 실패만 초기화하고 IP 기록은 즉시 삭제하지 않는다.
- bootstrap endpoint에도 rate limit을 적용한다.
- cookie parser를 `@fastify/cookie` 또는 예외 안전한 함수로 교체한다.
- CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS 등을 앱 또는 reverse proxy에서 명시한다.
- 공개 `/health`는 `ok` 정도만 반환하고 job ID·queue 상세는 인증된 diagnostics endpoint로 분리한다.

---

# 11. 업로드 검증은 Linux 기준으로는 방어되어 있지만 Windows와 quota가 남아 있다

업로드는 다음 방어를 갖고 있다.

- 절대 경로·`..`·역슬래시 거부
- `wx`로 중복 파일 덮어쓰기 방지
- 파일 수·개별 크기·전체 크기 제한
- `.git`, `.sf`, `.sfdx`, `node_modules`, 키 파일 제외
- `packageDirectories`가 실제 프로젝트 내부인지 realpath 확인

소스:

- `src/web/server/project-upload-routes.ts`
- `src/web/server/workspace-service.ts`

보완할 부분은 다음과 같다.

- 금지 디렉터리 비교가 대소문자를 구분한다. `.GIT`, `Node_Modules` 등이 통과한다.
- Windows의 `:` alternate data stream, `CON`, `AUX`, `NUL`, trailing dot·space를 검사하지 않는다.
- 최종 `targetPath`에 대해 resolved containment를 한 번 더 확인하지 않는다.
- 한 요청은 100MB지만 여러 번 업로드하는 전체 사용자 quota는 없다.
- 서버 비정상 종료 시 과거 `sfud-uploads-*` 디렉터리가 남을 수 있다.
- `findManifests()`는 모든 오류를 빈 목록으로 처리해 권한 오류나 파일시스템 문제도 “manifest 없음”으로 숨긴다.

금지 directory 비교는 소문자로 정규화하고, 최종 경로를 다음처럼 검사하는 것이 안전하다.

```ts
const resolvedTarget = path.resolve(upload.directory, ...segments);
const relative = path.relative(upload.directory, resolvedTarget);

if (
  relative.startsWith(`..${path.sep}`) ||
  relative === '..' ||
  path.isAbsolute(relative)
) {
  throw new Error('업로드 경로가 프로젝트 밖을 가리킵니다.');
}
```

서버 시작 시 일정 시간 이상 된 과거 `sfud-uploads-*` 디렉터리를 소유자·권한·mtime 확인 후 정리하는 scavenger도 필요하다.

---

# 12. 웹의 local ↔ local 비교가 연결된 org에 의존한다

`listMetadataTypes()`는 선택 소스 중 org alias를 수집한다. org가 하나도 없으면 첫 번째 연결된 org를 fallback으로 사용하고, 연결된 org도 없으면 빈 목록을 반환한다.

소스: `src/web/server/workspace-service.ts`

웹 UI는 metadata type을 반드시 선택해야 비교 버튼을 활성화한다. 따라서 서버 프로젝트 두 개만 있고 연결된 Salesforce org가 없는 환경에서는 CLI의 local ↔ local 비교는 가능하지만 웹 비교는 metadata type 목록이 없어 실행할 수 없다.

## 개선 방향

로컬 프로젝트는 자체 package directory에서 metadata type을 탐색해야 한다. 이미 동적 manifest 생성 코드에 로컬 metadata type discovery 로직이 있으므로 이를 공통 서비스로 추출하는 것이 적절하다.

```text
org source   → sf org list metadata-types
local source → packageDirectories + *-meta.xml root element
결과         → 양쪽 합집합
```

Metadata registry 결과를 alias/API version/project checksum 기준으로 cache할 수 있다.

---

# 13. Apex 테스트 후보 API와 UI 설명이 일치하지 않는다

UI와 README는 desired source의 모든 Apex Class 후보를 표시하고 실제 테스트 클래스인지 사용자가 선택한다고 설명한다.

소스:

- `ui/src/App.tsx`
- `README.md`

그러나 `/api/v1/apex-test-classes`는 사용자 설정의 suffix와 일치하는 클래스만 반환한다.

```ts
.filter((className) =>
  hasTestClassSuffix(className, settings.testClassSuffix)
);
```

소스: `src/web/server/comparison-routes.ts`

따라서 `_Test` 규칙을 사용하지 않는 `AccountServiceSpec`, `AccountServiceTest` 같은 클래스는 picker에 나타나지 않는다. 직접 입력은 가능하지만 UI 설명과 서버 결과가 다르다.

## 개선 방향

전체 후보를 반환하고 suffix 일치 여부를 별도 속성으로 제공하는 것이 적절하다.

```ts
{
  name: "AccountServiceSpec",
  matchesConfiguredSuffix: false
}
```

UI에서는 suffix 일치 항목을 먼저 보여주되 나머지를 숨기지 않아야 한다.

---

# 14. XML·메타데이터 비교는 generic heuristic의 한계가 있다

XML 배열의 동일 항목 판단은 `fullName`, `name`, `field`, `object`, `label` 등의 제한된 key 목록을 사용한다. 고유 key가 없거나 중복되면 배열 인덱스로 비교한다.

소스: `src/metadata/xml-diff.ts`

Salesforce metadata마다 반복 element의 의미가 다르므로 다음 오판 가능성이 있다.

- 단순 순서 변경을 다수의 값 변경으로 판단
- `label`이 실제 identity가 아닌데 같은 항목으로 판단
- key가 없는 배열에서 한 항목 삽입 후 후속 항목 전체가 변경으로 표시
- metadata type별로 순서가 의미 있는 경우와 없는 경우를 구분하지 못함

또한 지원 규칙이 없는 metadata directory는 generic fallback으로 처리되므로 component grouping 정확도가 metadata type에 따라 달라질 수 있다.

## 개선 방향

`metadata type + XML path` 기반의 identity·order 정책을 별도 registry로 분리해야 한다.

```ts
const XML_SEMANTICS = {
  Profile: {
    'Profile.fieldPermissions': {
      identity: 'field',
      ordered: false,
    },
  },
  Layout: {
    'Layout.layoutSections': {
      identity: 'label',
      ordered: true,
    },
  },
};
```

그리고 비교 결과를 다음처럼 분리하는 것이 명확하다.

```text
semanticEqual: true/false
rawTextEqual: true/false
```

현재처럼 non-strict 비교에서 `IDENTICAL`인데 양쪽 SHA-256은 다른 결과도 설명하기 쉬워진다.

---

# 15. UI와 API 계약을 기능 단위로 분리해야 한다

`ui/src/App.tsx`에 다음 내용이 한 파일에 함께 들어 있다.

- API response 타입
- 인증 화면
- 대시보드
- 비교
- 배포 cart
- Apex 테스트 선택
- SSE
- polling
- 관리자 화면
- 설정
- 아이콘
- 결과 렌더링

소스: `ui/src/App.tsx`

서버와 공유되는 타입은 health와 auth 일부뿐이며, 비교·배포 타입은 UI에서 다시 정의한다.

소스: `src/web/shared/api.ts`

이번에 발견된 직접 배포 `testLevel` 누락도 이러한 계약 중복의 결과로 볼 수 있다. TypeScript 인터페이스가 있어도 서버 route와 UI body가 별도로 작성되므로 컴파일 단계에서 불일치를 잡지 못한다.

## 권장 구조

```text
ui/src/
├── api/
│   ├── client.ts
│   └── schemas.ts
├── auth/
│   ├── AuthPage.tsx
│   └── useAuth.ts
├── workspace/
│   └── useWorkspace.ts
├── comparison/
│   ├── ComparisonPage.tsx
│   ├── ComparisonResult.tsx
│   └── useComparisonJob.ts
├── deployment/
│   ├── DeploymentPage.tsx
│   ├── DeploymentCart.tsx
│   ├── TestPlanForm.tsx
│   └── useDeploymentJob.ts
├── admin/
├── components/
└── App.tsx
```

API client는 다음을 공통 처리해야 한다.

- JSON parsing
- 401 시 auth 상태 초기화
- CSRF header
- error code와 message parsing
- timeout과 abort
- idempotency key
- 요청·응답 runtime validation

Fastify JSON Schema 또는 TypeBox 같은 단일 schema로 route validation과 UI 타입을 함께 생성하면 계약 누락을 줄일 수 있다.

배포 화면의 복잡한 ref와 effect 조합은 reducer 또는 명시적 상태 머신으로 옮기는 것이 적절하다.

```text
IDLE
→ COMPARING
→ COMPONENTS_SELECTED
→ DRY_RUNNING
→ APPROVAL_READY
→ DEPLOYING
→ SUCCEEDED | FAILED | RECONCILE_REQUIRED
```

---

# 16. CI와 배포 패키지 재현성을 확장할 필요가 있다

패키지는 Node `>=20.19`를 지원한다고 선언하지만 CI는 Ubuntu와 Node 24 한 조합만 검증한다.

소스:

- `package.json`
- `.github/workflows/ci.yml`

이 프로젝트는 다음 플랫폼 의존 코드가 있어 단일 Linux 환경만으로는 부족하다.

- `spawn`, signal, child process tree
- Windows path와 업로드 파일명
- 브라우저 열기
- sqlite3 native binding
- 실행 파일 권한
- 파일 mode 처리

권장 matrix는 다음과 같다.

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [20, 22, 24]
```

모든 조합에서 Playwright를 돌릴 필요는 없고 다음처럼 분리할 수 있다.

```text
Linux Node 24  → 전체 verify + Playwright
Linux Node 20  → 최소 지원 버전 unit/build
Linux Node 22  → unit/build
Windows Node 20/24 → process/path/upload/package smoke
```

추가로 현재 package script에는 lint, dead-code 검사, coverage threshold가 없다. `ComparePage`처럼 이전 흐름으로 보이는 코드가 남아 있는지 확인하기 위해 ESLint와 unused export 검사를 추가할 수 있다.

릴리스 tarball의 production dependencies가 caret 범위이므로 tarball checksum이 같아도 설치 시점에 해석되는 하위 dependency 버전은 달라질 수 있다. GitHub Release tarball 설치 방식을 유지한다면 `npm-shrinkwrap.json`, 정확한 dependency 버전, SBOM 중 하나를 적용하는 것이 재현성 측면에서 적절하다.

---

# 권장 작업 순서

## 1차: 실제 배포 안전성

1. 직접 배포 `testLevel` 전달 및 `skipDryRun` 정책 수정
2. 외부 Salesforce 결과와 로컬 DB 결과 상태 분리
3. 직접 배포 idempotency key 추가
4. target/source immutable org identity 저장
5. `RECONCILE_REQUIRED` 조회·확정 기능 추가

## 2차: 장애와 운영 대응

1. wait/timeout 정책 통합
2. 프로세스 output 상한 및 강제 종료
3. polling backoff와 전체 deadline 적용
4. graceful shutdown
5. bounded queue, 사용자별 요청 제한, target org별 lock
6. 구조화 로그와 디스크 여유 공간 검사

## 3차: 저장 구조와 확장성

1. job summary와 상세 artifact 분리
2. `listRecentSummary()` projection 쿼리
3. server-side pagination
4. streaming checksum
5. diff 크기 제한
6. 보존 기간·quota·압축·파일 권한 적용

## 4차: 유지보수성과 비교 정확성

1. UI 기능 단위 분할
2. API runtime schema 공유
3. local metadata type discovery 공통화
4. Apex 후보 suffix 필터 불일치 수정
5. metadata type별 XML semantic registry
6. Node·OS CI matrix와 오류 주입 테스트

---

# 반드시 추가할 회귀 테스트

| 테스트 | 기대 결과 |
|---|---|
| 직접 배포 + `RunLocalTests` + tests 없음 | `RunLocalTests` 유지, `NoTestRun`으로 변경되지 않음 |
| Salesforce ID 수신 후 progress DB 저장 실패 | `FAILED`가 아닌 `RECONCILE_REQUIRED` |
| 실제 배포 성공 후 artifact 저장 실패 | 원격 성공 상태 보존 |
| 같은 idempotency key로 직접 배포 2회 | 같은 job 반환 |
| `waitMinutes=60` retrieve | 프로세스 timeout 60분 이상 |
| child가 `SIGTERM` 무시 | grace 후 강제 종료 |
| 잘못된 `%`가 포함된 cookie | 500이 아닌 비인증 응답 |
| reverse proxy 뒤 서로 다른 클라이언트 | IP 제한이 서로 분리됨 |
| org 없이 local ↔ local 비교 | metadata type 목록 생성 가능 |
| suffix와 다른 Apex 테스트 클래스 | 후보 목록에는 표시됨 |
| 트랜잭션 중 별도 update 후 rollback | 별도 update가 rollback되지 않음 |
| 대형 diff 작업 목록 조회 | 상세 JSON을 parse하지 않고 summary만 조회 |

# 최종 결론

현재 설계에서 유지해야 할 부분은 request workspace 격리, payload checksum, shell 비사용, 역할·CSRF·감사 기록, 명시적 job 상태 모델이다.

반대로 다음 버전에서는 metadata type 추가나 화면 기능 확장보다 아래 세 항목이 먼저다.

1. **직접 배포의 test level 불일치 제거**
2. **Salesforce 외부 결과와 SQLite 로컬 결과의 이중 상태 문제 해결**
3. **중복 배포 방지를 위한 idempotency와 immutable org identity 도입**

이 세 항목을 해결한 뒤 프로세스 상한, DB 상세 결과 분리, queue·shutdown·reconciliation을 보완하면 원격 다중 사용자와 대형 Salesforce 프로젝트에서도 현재의 안전장치가 유지되는 구조가 된다.
