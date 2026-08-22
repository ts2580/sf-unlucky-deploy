# sf-unlucky-deploy

Salesforce org와 로컬 Salesforce DX 프로젝트의 메타데이터를 비교하고, 동일한 결과물을 검증한 뒤 배포하기 위한 TypeScript CLI 프로젝트다.

> 현재 상태: TypeScript CLI 기반 구성 완료. 메타데이터 비교·배포 명령은 아직 구현 전이다.

## 목표

- org와 org의 메타데이터 비교
- 로컬 Salesforce DX 프로젝트와 org 비교
- 컴포넌트 유무 및 실제 내용 차이 출력
- org에서 조회한 메타데이터를 다른 org에 검증·배포
- 로컬 프로젝트의 메타데이터를 org에 검증·배포
- 비교한 staging payload와 실제 배포 payload의 동일성 보장

세부 설계와 단계별 완료 조건은 [작업 계획](./working/2026-08-22-salesforce-metadata-compare-deploy-plan.md)에서 관리한다.

## 요구 사항

- Node.js 20 이상
- npm
- Salesforce CLI v2 (`sf`)
- Git

Salesforce org 인증은 이 프로젝트 외부의 Salesforce CLI 인증 저장소에서 관리한다. access token이나 SFDX auth URL을 저장소에 기록하지 않는다.

## 시작하기

```bash
npm ci
npm run check
npm run dev -- --help
```

현재 제공되는 명령은 CLI 도움말과 버전 확인이다.

```bash
npm run dev -- --help
npm run dev -- --version
```

## 개발 명령

| 명령 | 설명 |
|---|---|
| `npm run dev -- <args>` | TypeScript 소스에서 CLI 실행 |
| `npm run typecheck` | TypeScript 정적 타입 검사 |
| `npm test` | Vitest 단위 테스트 실행 |
| `npm run build` | 실행 파일을 `dist/`에 빌드 |
| `npm run check` | 타입 검사, 테스트, 빌드를 순서대로 실행 |

빌드 후에는 다음과 같이 실행할 수 있다.

```bash
node dist/cli.js --help
```

## 예정된 사용 방식

다음 명령은 설계가 확정된 인터페이스이며 아직 구현되지 않았다.

```bash
# org ↔ org 비교
sfud compare --left org:dev --right org:prod \
  --manifest manifest/package.xml

# local ↔ org 비교
sfud compare --left local:. --right org:prod \
  --manifest manifest/package.xml

# org → org 검증 배포
sfud deploy --from org:dev --to prod \
  --manifest manifest/package.xml

# local → org 검증 배포
sfud deploy --from local:. --to prod \
  --manifest manifest/package.xml
```

배포의 기본 동작은 `dry-run`으로 설계한다. 실제 배포에는 별도의 `--execute` 옵션이 필요하며, 메타데이터 삭제는 diff 결과만으로 자동 실행하지 않는다.

## 현재 구조

```text
.
├── src/
│   ├── cli.ts
│   └── program.ts
├── test/
│   └── program.test.ts
├── working/
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

빌드 결과, 의존성, Salesforce CLI 로컬 상태와 실행 리포트는 Git에서 제외한다.
