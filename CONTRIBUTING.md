# 개발과 릴리스

[README로 돌아가기](./README.md)

## 개발 환경 준비

```bash
npm ci
npx playwright install chromium
npm run verify
```

소스에서 CLI를 실행하려면 `npm run dev -- <args>`를 사용한다.

## 개발 명령

| 명령 | 설명 |
|---|---|
| `npm run dev -- <args>` | TypeScript 소스에서 CLI 실행 |
| `npm run typecheck` | CLI와 E2E TypeScript 검사 |
| `npm run lint` | JavaScript 설정·스크립트 ESLint 검사 |
| `npm run dead-code` | Knip 미사용 파일·export 검사 |
| `npm run quality` | lint와 미사용 코드 검사 |
| `npm test` | Vitest 단위·fixture 테스트 |
| `npm run test:e2e` | Playwright HTML 리포트 테스트 |
| `npm run test:platform` | process·path·관리 저장소·Git 수신·암호화 SQLite 플랫폼 스모크 |
| `npm run build` | `dist/` 빌드 |
| `npm run check` | 타입, 품질, Vitest, 빌드 검사 |
| `npm run package:smoke` | tarball 생성·설치, dependency tree와 CLI 실행 검증 |
| `npm run verify` | `check`와 Playwright 전체 검증 |

## CI와 릴리스 산출물

Pull Request와 공유 브랜치는 Linux Node.js 24의 전체 단위·브라우저·패키지 검증, Linux
Node.js 22.19.0의 최소 지원 버전 검증, Windows Node.js 24의 플랫폼 스모크를
통과해야 한다. TypeScript의 미사용 선언 검사와 Knip의 미사용 export·파일 검사도 `check`에
포함된다.

태그 릴리스는 npm 11.20.0으로 `npm-shrinkwrap.json`이 포함된 tarball을 만든 뒤, 그 tarball을
새 prefix에 설치해 전체 dependency tree와 `sfud --version`을 검증한다. GitHub Release에는
tarball, SHA-256 체크섬과 CycloneDX JSON SBOM을 각각 첨부한다. SBOM은 공급망 구성의 가시성을
위한 별도 산출물이며, 설치 재현성은 `npm-shrinkwrap.json`과 tarball 설치 검증으로 확보한다.

## 브랜치 승격 규칙

기능은 다음 순서로 승격한다.

```text
feat/* 또는 fix/* → canary → main
```

- 기능 브랜치에서 구현과 fixture 검증
- `canary` 병합 후 전체 검증
- `main` 병합 전 canary 결과 재확인
- 기능 단위로 커밋하고 작은 중간 커밋을 남발하지 않음

RC는 `canary`에서 GitHub prerelease와 npm `next`로 공개한다. RC 검증 후 정식 버전으로 변경하고 `canary → main` PR을 병합한 다음 정식 태그를 생성한다. 브랜치 병합만으로 패키지를 발행하지 않는다.

GitHub Release의 설치 검증이 완료되면 `publish-npm.yml`을 해당 태그 ref로 수동 실행한다. npm은 정식 버전도 우선 `next`에 발행하고, registry 산출물 검증 후 소유자가 `latest`로 별도 승격한다. 원본 Release와 동일한 태그·커밋·파일의 발행 재시도는 허용하며, 해당 커밋이 RC는 `canary`, 정식은 `main` 이력에 있어야 한다.

## 현재 검증 범위

- TypeScript 타입 검사
- Vitest 단위·fixture 테스트
- mock `sf` 기반 org ↔ org 비교와 배포 안전장치
- 실제 Salesforce CLI 기반 local ↔ local source 변환·비교
- Playwright Chromium 기반 데스크톱·모바일 HTML 렌더링

실제 org 전체 범위 검증은 배포 대상과 manifest를 명시적으로 정한 뒤 수행한다. 저장소 검증에서는 작은 단일 컴포넌트 check-only만 실행한다.
