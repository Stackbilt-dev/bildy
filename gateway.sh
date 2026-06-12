#!/usr/bin/env bash
set -euo pipefail

REAL_SCRIPT="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start-gateway.sh"
PID_FILE="${GATEWAY_PID_FILE:-/tmp/llm-gateway.pid}"
LOG_FILE="${GATEWAY_LOG_FILE:-/tmp/llm-gateway.log}"
PORT="${BILDY_GATEWAY_PORT:-8787}"
GATEWAY_URL="http://localhost:${PORT}"
GATEWAY_KEY="${BILDY_GATEWAY_KEY:-local-dev-key}"
ENV_FILE="${SCRIPT_DIR}/.env"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gateway] ERROR: missing required command: $1"
    exit 1
  fi
}

load_env_if_present() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
  fi
}

upsert_env_key() {
  local key="$1"
  local value="$2"
  ensure_env_file
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*$|${key}=\"${value}\"|" "$ENV_FILE"
  else
    printf '%s="%s"\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

prompt_key_if_missing() {
  local key="$1"
  local label="$2"
  local current="${!key:-}"
  if [[ -n "$current" ]]; then
    echo "[init] ${key} already set"
    return 0
  fi

  printf "%s (leave blank to skip): " "$label"
  local value
  read -r value
  if [[ -n "$value" ]]; then
    upsert_env_key "$key" "$value"
    export "$key=$value"
    echo "[init] saved ${key}"
  else
    echo "[init] skipped ${key}"
  fi
}

prompt_optional_default() {
  local key="$1"
  local label="$2"
  local default_value="$3"
  local current="${!key:-}"
  if [[ -n "$current" ]]; then
    echo "[init] ${key} already set"
    return 0
  fi

  printf "%s [%s]: " "$label" "$default_value"
  local value
  read -r value
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi

  upsert_env_key "$key" "$value"
  export "$key=$value"
  echo "[init] saved ${key}"
}

is_healthy() {
  curl -sf "${GATEWAY_URL}/health" >/dev/null 2>&1
}

is_pid_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

print_unique_pids() {
  awk '!seen[$1]++ && $1 ~ /^[0-9]+$/ { print $1 }'
}

find_gateway_pids() {
  {
    if command -v lsof >/dev/null 2>&1; then
      lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true
      printf '\n'
    fi

    if command -v fuser >/dev/null 2>&1; then
      fuser "${PORT}/tcp" 2>/dev/null || true
      printf '\n'
    fi

    if command -v ss >/dev/null 2>&1; then
      ss -ltnp "sport = :${PORT}" 2>/dev/null \
        | sed -nE 's/.*pid=([0-9]+).*/\1/p' || true
      printf '\n'
    fi

    ps -eo pid=,args= 2>/dev/null \
      | awk -v port="$PORT" '
          /dist\/cli\.js start/ && ($0 ~ "--port " port || $0 ~ "--port=" port) { print $1 }
        ' || true
  } | tr ' ' '\n' | print_unique_pids
}

manual_stop_hint() {
  echo "[gateway] manual stop candidates:"
  echo "  lsof -tiTCP:${PORT} -sTCP:LISTEN | xargs -r kill"
  echo "  pkill -f 'dist/cli.js start --port ${PORT}'"
}

stop_pids() {
  local label="$1"
  shift
  local pids=("$@")

  if (( ${#pids[@]} == 0 )); then
    return 1
  fi

  echo "[gateway] stopping ${label} pid(s): ${pids[*]}..."
  kill "${pids[@]}" >/dev/null 2>&1 || true

  local tries=0
  while (( tries < 10 )); do
    local still_running=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        still_running=1
        break
      fi
    done

    if (( still_running == 0 )); then
      return 0
    fi

    sleep 1
    tries=$((tries + 1))
  done

  echo "[gateway] warning: pid(s) still running after TERM; sending KILL"
  kill -9 "${pids[@]}" >/dev/null 2>&1 || true
}

start_gateway() {
  require_cmd curl

  if is_healthy; then
    echo "[gateway] already running at ${GATEWAY_URL}"
    return 0
  fi

  if is_pid_running; then
    local stale_pid
    stale_pid="$(cat "$PID_FILE")"
    echo "[gateway] found running pid ${stale_pid} but healthcheck failed; restarting"
    kill "$stale_pid" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi

  echo "[gateway] starting on port ${PORT}..."
  setsid env BILDY_GATEWAY_PORT="$PORT" bash "$START_SCRIPT" --port "$PORT" >"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" >"$PID_FILE"

  local tries=0
  while (( tries < 20 )); do
    if is_healthy; then
      echo "[gateway] up (pid ${pid})"
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done

  echo "[gateway] ERROR: failed to start"
  echo "[gateway] log: ${LOG_FILE}"
  rm -f "$PID_FILE"
  exit 1
}

stop_gateway() {
  if ! is_pid_running; then
    if is_healthy; then
      echo "[gateway] healthy at ${GATEWAY_URL}, but pid file is missing or unusable: ${PID_FILE}"
      local fallback_pids=()
      mapfile -t fallback_pids < <(find_gateway_pids)

      if (( ${#fallback_pids[@]} == 0 )); then
        echo "[gateway] could not identify the unmanaged gateway process"
        manual_stop_hint
        return 1
      fi

      stop_pids "unmanaged gateway" "${fallback_pids[@]}"
      rm -f "$PID_FILE"
      echo "[gateway] stopped"
      return 0
    fi
    echo "[gateway] not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  stop_pids "managed gateway" "$pid"
  rm -f "$PID_FILE"
  echo "[gateway] stopped"
}

status_gateway() {
  local status="down"
  if is_healthy; then
    status="up"
  fi

  echo "status=${status}"
  echo "url=${GATEWAY_URL}"
  echo "pid_file=${PID_FILE}"
  echo "log_file=${LOG_FILE}"

  if is_pid_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    echo "pid=${pid}"
    if [[ "$status" == "up" ]]; then
      echo "pid_state=managed"
    else
      echo "pid_state=stale_unhealthy"
    fi
  else
    echo "pid=none"
    if [[ "$status" == "up" ]]; then
      echo "pid_state=healthy_unmanaged"
      local fallback_pids=()
      mapfile -t fallback_pids < <(find_gateway_pids)
      if (( ${#fallback_pids[@]} > 0 )); then
        echo "unmanaged_pids=${fallback_pids[*]}"
      fi
    else
      echo "pid_state=none"
    fi
  fi
}

show_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "[gateway] no log file at ${LOG_FILE}"
    return 0
  fi
  tail -n 120 "$LOG_FILE"
}

ensure_up() {
  load_env_if_present
  if is_healthy; then
    return 0
  fi
  start_gateway
}

shell_init() {
  cat <<'SHELL'
__bildy_ensure_up() {
  if [[ -n "${BILDY_GATEWAY_URL:-}" ]]; then return 0; fi
  bildy-gw __ensure-up >&2
}

claude-gw() {
  __bildy_ensure_up
  local _gw_url="${BILDY_GATEWAY_URL:-http://localhost:${BILDY_GATEWAY_PORT:-8787}}"
  local _gw_key="${BILDY_GATEWAY_KEY:-local-dev-key}"
  ANTHROPIC_BASE_URL="$_gw_url" ANTHROPIC_API_KEY="$_gw_key" command claude "$@"
}

codex-gw() {
  __bildy_ensure_up
  local _gw_url="${BILDY_GATEWAY_URL:-http://localhost:${BILDY_GATEWAY_PORT:-8787}}"
  local _gw_key="${BILDY_GATEWAY_KEY:-local-dev-key}"
  OPENAI_BASE_URL="$_gw_url/v1" OPENAI_API_KEY="$_gw_key" BILDY_GATEWAY_KEY="$_gw_key" command codex "$@"
}
SHELL
}

doctor() {
  local failures=0
  local warnings=0

  echo "[doctor] gateway quick checks"

  load_env_if_present

  if command -v node >/dev/null 2>&1; then
    echo "[ok] node found: $(node -v)"
  else
    echo "[fail] node is required"
    failures=$((failures + 1))
  fi

  if command -v npm >/dev/null 2>&1; then
    echo "[ok] npm found: $(npm -v)"
  else
    echo "[fail] npm is required"
    failures=$((failures + 1))
  fi

  if command -v curl >/dev/null 2>&1; then
    echo "[ok] curl found"
  else
    echo "[fail] curl is required"
    failures=$((failures + 1))
  fi

  if [[ -f "$ENV_FILE" ]]; then
    echo "[ok] .env file found"
  else
    echo "[fail] missing .env at $ENV_FILE"
    failures=$((failures + 1))
  fi

  local provider_count=0
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "[ok] anthropic configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo "[ok] openai configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${GROQ_API_KEY:-}" ]]; then
    echo "[ok] groq configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${CEREBRAS_API_KEY:-}" ]]; then
    echo "[ok] cerebras configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${NVIDIA_API_KEY:-}" ]]; then
    echo "[ok] nvidia configured"
    provider_count=$((provider_count + 1))
  fi
  if [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" && -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    echo "[ok] cloudflare configured via account+token"
    provider_count=$((provider_count + 1))
  fi

  if (( provider_count == 0 )); then
    echo "[fail] no providers configured in environment"
    echo "       set at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, or CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN"
    failures=$((failures + 1))
  fi

  if command -v claude >/dev/null 2>&1; then
    echo "[ok] claude cli found"
  else
    echo "[warn] claude cli not found (needed for 'gateway.sh claude')"
    warnings=$((warnings + 1))
  fi

  if command -v codex >/dev/null 2>&1; then
    echo "[ok] codex cli found"
  else
    echo "[warn] codex cli not found (needed for 'gateway.sh codex')"
    warnings=$((warnings + 1))
  fi

  if [[ -n "${BILDY_GATEWAY_URL:-}" ]]; then
    echo "[ok] remote gateway: ${BILDY_GATEWAY_URL} (local startup skipped)"
  else
    echo "[doctor] gateway url: ${GATEWAY_URL}"
  fi
  echo "[doctor] gateway key: ${GATEWAY_KEY:+set}"
  echo "[doctor] checks complete: failures=${failures}, warnings=${warnings}"

  if (( failures > 0 )); then
    return 1
  fi
}

init() {
  local quick_mode="${1:-}"

  echo "[init] configuring gateway provider keys in ${ENV_FILE}"
  load_env_if_present
  ensure_env_file

  if [[ "$quick_mode" == "--quick" ]]; then
    echo "[init] quick mode: only asking for one provider key to get started"
    prompt_key_if_missing "GROQ_API_KEY" "Groq API key"
    if [[ -z "${GROQ_API_KEY:-}" ]]; then
      prompt_key_if_missing "OPENAI_API_KEY" "OpenAI API key"
    fi
    if [[ -z "${GROQ_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
      prompt_key_if_missing "ANTHROPIC_API_KEY" "Anthropic API key"
    fi
  else
    prompt_key_if_missing "GROQ_API_KEY" "Groq API key"
    prompt_key_if_missing "CEREBRAS_API_KEY" "Cerebras API key"
    prompt_key_if_missing "ANTHROPIC_API_KEY" "Anthropic API key"
    prompt_key_if_missing "OPENAI_API_KEY" "OpenAI API key"
    prompt_key_if_missing "CLOUDFLARE_ACCOUNT_ID" "Cloudflare Account ID"
    prompt_key_if_missing "CLOUDFLARE_API_TOKEN" "Cloudflare API Token"
  fi

  prompt_optional_default "BILDY_GATEWAY_KEY" "Gateway local auth key" "local-dev-key"
  prompt_optional_default "BILDY_GATEWAY_PORT" "Gateway port" "8787"

  echo "[init] running doctor..."
  if doctor; then
    echo "[init] setup complete"
  else
    echo "[init] doctor found setup gaps. Re-run 'bildy-gw init' anytime."
  fi
}

launch_claude() {
  require_cmd claude
  start_gateway
  echo "[gateway] routing Claude Code through ${GATEWAY_URL}"
  exec env \
    ANTHROPIC_BASE_URL="${GATEWAY_URL}" \
    ANTHROPIC_API_KEY="${GATEWAY_KEY}" \
    claude "$@"
}

launch_codex() {
  require_cmd codex
  start_gateway
  echo "[gateway] routing Codex-compatible OpenAI API traffic through ${GATEWAY_URL}/v1"
  exec env \
    OPENAI_BASE_URL="${GATEWAY_URL}/v1" \
    OPENAI_API_KEY="${GATEWAY_KEY}" \
    BILDY_GATEWAY_KEY="${GATEWAY_KEY}" \
    codex "$@"
}

usage() {
  cat <<'EOF'
Usage:
  ./gateway.sh up
  ./gateway.sh down
  ./gateway.sh restart
  ./gateway.sh status
  ./gateway.sh logs
  ./gateway.sh doctor
  ./gateway.sh init [--quick]
  ./gateway.sh shell-init
  # shell-init exposes helper commands without overriding native CLIs:
  #   claude-gw [args...]  codex-gw [args...]
  ./gateway.sh claude [claude args...]
  ./gateway.sh codex [codex args...]

Environment overrides:
  BILDY_GATEWAY_URL  (remote gateway URL — skips local startup when set)
  BILDY_GATEWAY_PORT (default: 8787)
  BILDY_GATEWAY_KEY  (default: local-dev-key)
  BILDY_GATEWAY_CACHE_DIR (optional cache sqlite directory; useful for sandboxes)
  GATEWAY_PID_FILE       (default: /tmp/llm-gateway.pid)
  GATEWAY_LOG_FILE       (default: /tmp/llm-gateway.log)
EOF
}

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  usage
  exit 1
fi
shift || true

case "$cmd" in
  up) start_gateway ;;
  down) stop_gateway ;;
  restart) stop_gateway || true; start_gateway ;;
  status) status_gateway ;;
  logs) show_logs ;;
  doctor) doctor ;;
  init) init "$@" ;;
  shell-init) shell_init ;;
  __ensure-up) ensure_up ;;
  claude) launch_claude "$@" ;;
  codex) launch_codex "$@" ;;
  *)
    usage
    exit 1
    ;;
esac
