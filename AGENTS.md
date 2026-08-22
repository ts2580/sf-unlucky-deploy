# 저장소 작업 규칙

이 파일의 규칙은 저장소 전체에 적용한다.

## 공유 브랜치 병합 정책

- `main`과 `canary`에는 직접 push하지 않는다.
- force push를 포함해 로컬에서 `main` 또는 `canary`로 변경을 밀어 넣지 않는다.
- 모든 변경은 `feature/*`, `fix/*`, `docs/*` 등 별도 작업 브랜치에서 커밋하고 push한다.
- 작업 브랜치의 변경은 Pull Request를 통해서만 `canary`에 병합한다.
- `canary` 검증을 통과한 변경은 `canary`에서 `main`으로 보내는 Pull Request를 통해서만 병합한다.
- Pull Request의 필수 검증이 성공한 것을 확인한 뒤 병합한다.
- `main`과 `canary`의 동기화나 긴급 변경도 직접 push하지 않고 Pull Request를 사용한다.
