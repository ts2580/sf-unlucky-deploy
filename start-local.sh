#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

load_sfud_env() {
  local env_file="$1"
  local env_dump
  local env_entry
  local env_key
  local env_value

  env_dump="$(mktemp)"
  if ! node -e '
    const { readFileSync } = require("node:fs");
    const { parseEnv } = require("node:util");
    const values = parseEnv(readFileSync(process.argv[1], "utf8"));
    for (const key of Object.keys(values).sort()) {
      if (/^SFUD_[A-Z0-9_]+$/.test(key)) {
        process.stdout.write(`${key}=${values[key]}\0`);
      }
    }
  ' "$env_file" > "$env_dump"; then
    rm -f -- "$env_dump"
    echo ".env 파일을 읽지 못했습니다: $env_file" >&2
    exit 2
  fi

  while IFS= read -r -d '' env_entry; do
    env_key="${env_entry%%=*}"
    env_value="${env_entry#*=}"
    if [[ ! -v "$env_key" ]]; then
      printf -v "$env_key" '%s' "$env_value"
      export "$env_key"
    fi
  done < "$env_dump"
  rm -f -- "$env_dump"
}

if ! command -v node >/dev/null 2>&1; then
  echo "sfud UI를 시작하려면 Node.js가 필요합니다." >&2
  exit 1
fi
if [[ -f "$ENV_FILE" ]]; then
  load_sfud_env "$ENV_FILE"
fi

UI_HOST="${SFUD_UI_HOST:-127.0.0.1}"
UI_PORT="${SFUD_UI_PORT:-27546}"
SHUTDOWN_TIMEOUT_SECONDS="${SFUD_SHUTDOWN_TIMEOUT_SECONDS:-5}"

if [[ ! "$UI_PORT" =~ ^[0-9]+$ ]] || ((UI_PORT < 1 || UI_PORT > 65535)); then
  echo "올바르지 않은 SFUD_UI_PORT입니다: $UI_PORT" >&2
  exit 2
fi
if [[ ! "$SHUTDOWN_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || ((SHUTDOWN_TIMEOUT_SECONDS < 1)); then
  echo "SFUD_SHUTDOWN_TIMEOUT_SECONDS는 1 이상의 정수여야 합니다." >&2
  exit 2
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "포트 점유 프로세스를 확인하려면 lsof가 필요합니다." >&2
  exit 1
fi
if [[ ! -f "$PROJECT_ROOT/dist/cli.js" ]]; then
  echo "dist/cli.js가 없습니다. 먼저 npm run build를 실행하세요." >&2
  exit 1
fi

mapfile -t LISTENER_PIDS < <(lsof -nP -tiTCP:"$UI_PORT" -sTCP:LISTEN | sort -u)
if ((${#LISTENER_PIDS[@]} > 0)); then
  echo "포트 $UI_PORT 점유 프로세스를 종료합니다: ${LISTENER_PIDS[*]}"
  for pid in "${LISTENER_PIDS[@]}"; do
    ps -p "$pid" -o pid=,args= || true
  done
  kill -TERM -- "${LISTENER_PIDS[@]}" 2>/dev/null || true

  deadline=$((SECONDS + SHUTDOWN_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    remaining=()
    for pid in "${LISTENER_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then remaining+=("$pid"); fi
    done
    ((${#remaining[@]} == 0)) && break
    sleep 0.2
  done

  remaining=()
  for pid in "${LISTENER_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then remaining+=("$pid"); fi
  done
  if ((${#remaining[@]} > 0)); then
    echo "정상 종료되지 않아 강제 종료합니다: ${remaining[*]}"
    kill -KILL -- "${remaining[@]}"
  fi
fi

cd "$PROJECT_ROOT"
UI_ARGS=(ui --host "$UI_HOST" --port "$UI_PORT" --no-open)
if [[ "$UI_HOST" != "127.0.0.1" && "$UI_HOST" != "localhost" && "$UI_HOST" != "::1" ]]; then
  UI_ARGS+=(--allow-remote)
fi

echo "sfud UI를 시작합니다: http://$UI_HOST:$UI_PORT"
exec node dist/cli.js "${UI_ARGS[@]}" "$@"
