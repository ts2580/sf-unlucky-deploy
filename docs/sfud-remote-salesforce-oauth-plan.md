# 원격 서버 Salesforce 브라우저 OAuth 구현 계획

작성: 2026-09-29

상태: IMPLEMENTED_LOCAL. 구현 담당 GPT-6 Luna, reasoning high. 주 에이전트가 설계·코드 검토 및 최종 검증 담당. 실제 Salesforce Org 승인 검증은 대기 중.

## 목표와 완료 기준

`LOCAL=false`의 인증 관리에서 별칭과 Salesforce 로그인 주소를 입력하고 로그인 버튼을 누르면, Salesforce 승인 후 원격 SFUD로 돌아와 본인 계정에 연결이 저장된다. 사용자 PC의 Salesforce CLI나 SSH 터널은 필요하지 않는다.

- 원격 OAuth 앱 및 HTTPS 주소가 설정된 환경에서 버튼 로그인 제공.
- 기존 LOCAL 모드, 사용자별 연결/실행 권한, SFDX 인증 URL 등록 호환 유지.
- 자동 테스트·브라우저 검증·전체 빌드 완료는 IMPLEMENTED_LOCAL로 기록. 실제 Org 승인과 연결 재사용 확인은 VERIFIED_REMOTE로 별도 기록.

## 설정

- `SFUD_PUBLIC_ORIGIN`: 브라우저에서 접근할 수 있는 고정 HTTPS origin. 기존 신뢰 프록시 설정과 연동.
- `SFUD_SF_OAUTH_CLIENT_ID`, `SFUD_SF_OAUTH_CLIENT_SECRET`: Salesforce External Client App 또는 기존 Connected App의 서버용 OAuth 자격 증명.
- `SFUD_SF_TOKEN_SECRET`: 기존 사용자별 인증 URL 암호화 비밀값 재사용.
- 콜백 주소는 설정된 origin + `/api/v1/salesforce/oauth/callback`으로 고정. 요청 Host/Forwarded 헤더나 사용자 입력으로 생성하지 않는다.
- 앱에 Web Server Flow와 PKCE를 설정하고 API 및 refresh token 권한을 부여한다. 대상 Org에서 앱 설치/사용 허용이 필요한 경우 해당 정책을 충족한다.
- 미설정·부분 설정·HTTP origin은 비활성 상태와 사용자가 이해할 수 있는 안내를 제공한다. 비밀값은 응답에 포함하지 않는다.

## 인증 흐름

1. `POST /api/v1/salesforce/oauth/start`: 인증 세션과 CSRF 검사. 별칭·Salesforce 로그인 주소 검사. 임의 state와 PKCE S256 verifier 생성, 시작 사용자 및 정확한 세션에 결합. 짧은 TTL과 시도 수 상한을 둔다.
2. HttpOnly·Secure·SameSite=Lax의 OAuth 전용 브라우저 확인 쿠키를 발급한다. 기존 세션 쿠키의 SameSite=Strict를 유지한다. 인증 페이지로 같은 탭에서 이동한다.
3. `GET /api/v1/salesforce/oauth/callback`: state·만료·브라우저 확인 쿠키를 검증하고 state를 일회성 소비한다. 원래의 세션 쿠키가 없어도 콜백 수신은 가능해야 한다. 성공 코드 또는 취소 결과를 서버의 짧은 수명 상태에 보관하고 고정 `/auth` 화면으로 이동한다. 인증 코드·토큰을 UI 반환 URL에 전달하지 않는다.
4. `POST /api/v1/salesforce/oauth/complete`: `/auth`가 다시 확보한 로그인 세션 및 CSRF로 완료 요청. 시작 시의 사용자·세션과 일치하고 여전히 유효한지 검증한 뒤 코드를 일회성 소비한다. 다른 사용자/다른 세션, 로그아웃, 재전송, 동시 완료를 차단한다.
5. 시작 시 고정한 Salesforce token endpoint로 코드·PKCE·앱 자격 증명을 전송한다. 리다이렉트 거부, 시간 제한, 입력/응답 크기 제한 적용. 필수 refresh token과 instance URL을 검증한다.
6. 기존 격리 CLI 검증 및 사용자별 SalesforceConnectionRepository를 사용하여 Org identity를 확인하고 인증 URL을 암호화 저장한다. 저장 직전에도 세션 유효성을 확인한다. 성공 시 연결 목록 갱신 및 안전한 상태 메시지 표시.

서버 재시작 시 진행 중인 인증은 만료 처리하며 다시 시작하도록 안내한다. 현재 단일 프로세스 구조에서는 메모리 내 임시 상태를 사용하되 TTL 정리와 전체/세션별 상한을 둔다. 분산 인스턴스 지원은 별도 작업이다.

## 안전성과 호환성

- Salesforce 로그인 및 응답 instance URL은 허용된 HTTPS Salesforce 도메인으로 제한한다. 임의 token endpoint/redirect/return URL을 받지 않는다.
- client secret, PKCE verifier, 인증 코드, access/refresh token, SFDX 인증 URL은 UI·로그·평문 DB에 노출하지 않는다. 애플리케이션 요청 로그에서 OAuth callback query를 제거한다.
- 결과는 연결을 시작한 본인 계정에만 저장한다. 기존 org 실행 권한을 자동 부여하지 않는다.
- 거절·만료·네트워크 오류·키 미설정은 안전한 고정 오류 메시지로 처리한다. Salesforce의 원문 오류/쿼리를 화면에 반사하지 않는다.
- 기존 LOCAL 로그인 및 수동 인증 URL 등록은 계속 동작한다. 원격 OAuth UI가 기본 진입점이며 수동 등록은 보조 경로로 제공한다.

## 작업 순서

1. OAuth 설정 및 임시 시도 서비스 구현.
2. start/callback/complete API, 연결 저장, 로그 처리 구현.
3. 원격 인증 UI 및 완료 처리, 기존 경로 호환 구현.
4. `.env.example` 및 README 설정/사용법 갱신.
5. 테스트 및 검토 후 수정, `npm run build` 실행.
6. 현재 서버의 실행 설정을 유지하여 재시작하고 새 정적 자산 제공 확인. 실제 OAuth 사용에는 별도의 HTTPS origin 및 Salesforce 앱 설정 필요.

## 검증

- 설정 준비 상태, origin/도메인/콜백 고정, PKCE 파라미터 및 세션 결합.
- 정상 연결·암호화 저장·사용자 격리·연결 재인증, 누락된 refresh token 및 잘못된 instance URL 거부.
- state 위조/누락/만료/재사용, 브라우저 쿠키 누락/오염, 다른 세션, 로그아웃, CSRF, 동일 콜백 및 완료의 동시 요청.
- Salesforce 거절, token endpoint 실패/timeout/redirect, 입력 및 응답 검증, 비밀값 로그 비노출.
- 실제 브라우저에서 Strict 세션 쿠키가 빠지는 교차 사이트 콜백과 로그인 화면 복귀·완료 동작 검증. 가능하면 로컬 HTTPS OAuth fixture로 API까지 검증하고 fixture 범위 명시.
- 모바일/PC 인증 화면, 로딩/미설정/성공/실패, 콘솔·페이지 오류, LOCAL 및 수동 등록 회귀.
- 타입 검사, 관련 단위/API/E2E 테스트, 품질 검사, 전체 빌드. 검토에서 드러난 위험에 한해 검증 범위 확대.

## 실제 환경 검증에 필요한 값

브라우저에서 접근 가능한 SFUD HTTPS origin, 등록된 OAuth 앱의 Client ID/Secret, 정확한 callback 등록, API/refresh token scope, 대상 Org 앱 허용 및 사용자 승인. 비밀값은 채팅이나 문서에 기록하지 않고 서버 설정으로 제공한다.

현재 환경 확인: `https://deploy.sfdcinsight.xyz/api/v1/health`가 200 및 `sfud-ui` 응답을 반환함. 계획된 callback은 `https://deploy.sfdcinsight.xyz/api/v1/salesforce/oauth/callback`. 현재 실행 프로세스와 `.env`에서 OAuth Client ID/Secret 및 `SFUD_SF_TOKEN_SECRET`은 미설정으로 확인됨. 실제 설정 적용 및 Org 승인 검증은 아직 수행하지 않음.

## 근거

- https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&language=en_US&type=5
- https://developer.salesforce.com/docs/platform/api-rest/guide/intro-oauth-and-connected-apps.html

## 진행 및 검증 결과

- OAuth 시도 서비스, start/callback/complete API, 원격 연결 UI, 설정 문서 구현 완료.
- 타입 검사 및 품질 검사 통과. 전체 Vitest 77개 파일 / 542개 테스트 통과. 관련 Salesforce 인증 테스트 20개 통과.
- 실제 HTTPS 브라우저와 모의 Salesforce 승인 페이지로 교차 사이트 복귀 검증 통과. 콜백에는 OAuth 전용 Lax 쿠키만 전달되고, Strict 세션/CSRF 쿠키는 전달되지 않음. 인증 화면 복귀 후 원래 세션으로 완료 요청 및 암호화 저장 확인. Salesforce token endpoint와 CLI는 모의 구현이므로 실제 Org 연결 증거로 간주하지 않음.
- CLI 및 UI 전체 빌드 통과. 기존 사용자 서버의 실행 인수·환경을 유지하여 재시작하고 공개 HTTPS에서 새 JavaScript 자산의 HTTP 200 및 올바른 MIME 확인.
- 전체 브라우저 회귀 64개 통과. 이후 추가한 원격 UI 검증을 포함하여 인증 UI 및 HTTPS OAuth 브라우저 테스트 5개 재실행 통과.
- 원격 연결 화면을 1440/1024/768/390/320px에서 측정하여 페이지 가로 넘침, 입력 주소 잘림, 필드·버튼 경계 이상 없음 확인. 페이지 및 콘솔 오류 없음. PC·모바일 스크린샷 직접 검토 완료. OAuth 미설정 안내와 수동 등록 펼치기 확인.
- 실제 서버의 OAuth 앱 자격 증명과 저장 암호화 키는 변경하지 않음. 설정 후 실제 Org 승인·재사용 검증이 필요하며 VERIFIED_REMOTE로 기록하지 않음.
