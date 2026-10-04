# 추가 리뷰 5건 수정 — 2026-09-22

상태: `IMPLEMENTED_LOCAL`. 기존 작업 트리를 보존했고 commit/push/원격 배포/압축/업로드는 하지 않았다.

## 수정 및 회귀 증거

1. Windows SF CLI: `cmd.exe /c`를 제거했다. npm 및 oclif Windows 설치의 Node 진입점을 직접 실행하고,
   사용자 업데이트 및 bundled Node를 탐색한다. 알 수 없는 shim은 시작 전 오류로 종료하며 셸 fallback은 없다.
   `test/sf-client.test.ts`에서 설치 fixture와 실제 Node subprocess를 사용해 `&`, `|`, `%`, `!`, `^`,
   괄호, 공백, 따옴표, 끝 backslash, 빈 인자의 보존을 확인한다.
   설치 구조 근거: [oclif Windows pack 구현](https://github.com/oclif/oclif/blob/main/src/commands/pack/win.ts).
2. Quick Deploy 수동 복구: service와 repository 모두 VALIDATE는 validation ID, DEPLOY/QUICK_DEPLOY는
   deployment ID의 유실 여부로 판단한다. 기존 검증 ID를 보존하며 관리자 권한·org identity·원격 report의
   ID와 checkOnly·감사 기록·재연결 거부는 유지한다. `test/deployment-attempts.test.ts`에서 응답 유실,
   재시작 복구, 관리자 실행 ID 연결, report만 사용한 성공 복구를 확인한다. 자동 재제출은 없다.
3. 큐 포화: 승인 저장 전/비교 준비 전 슬롯을 예약하고 실패 시 반납한다. 포화 요청은 HTTP 503 및
   REQUEST_CAPACITY_EXCEEDED로 반환하며 QUEUED 행이나 승인을 생성하지 않는다. 저장 중 큐 종료는
   QUEUED 작업을 실패 처리한다. `test/dry-run-api.test.ts`, `test/comparison-api.test.ts`에서
   슬롯 20개 포화 시 DB 불변과 슬롯 해제 후 정상 재요청·실행을 확인한다.
4. org 사용자명: workspace·권한 repository·관리 API·관리 화면에서 공통 식별자 규칙을 사용한다.
   `@`, `+`를 허용하며 경로/공백 등은 계속 거부한다. repository/API 회귀 및 별칭 없는 org의
   직접 배포·승인 배포를 SF fixture로 확인한다. 실제 Salesforce 배포 증거는 아니다.
5. 커버리지: 비교용 합집합 manifest 대신 고정 payload의 `package.xml`을 사용한다.
   `test/deploy.test.ts`에서 전체/타입 단위 비교의 TARGET ONLY 클래스가 보고되지 않아도 source의
   충분한 커버리지는 통과하고, 실제 payload의 누락/낮은 커버리지는 계속 차단되는지 확인한다.
   기존 API fixture의 변환 결과도 실제 선택 manifest를 포함하도록 보정했다.

## 검증

- `npm run check`: 72개 파일, 483개 테스트 통과. 타입 검사·품질 검사·CLI/UI 빌드 포함.
- `npm run lockfile:check`, `git diff --check`: 통과.
- `SFUD_E2E_SKIP_BUILD=1 npm run test:e2e -- e2e/ui.spec.ts`: 16개 통과. 관리 화면의
  `target+sandbox@example.com` 입력 유효성·권한 부여/회수와 주요 UI 회귀 포함.

## 남은 외부 검증

실제 Windows 기기의 npm/installer 설치, 원격 SF 장애 주입 및 실제 배포는 수행하지 않았다.
기존 working의 Windows·운영 검증 목록을 유지한다. 사용자 사설 GitLab에는 접속하지 않았다.
완료한 코드 수정 5건은 working의 미수정 항목으로 남기지 않는다.
