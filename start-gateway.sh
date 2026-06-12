#!/usr/bin/env bash
# Start the StackBilt LLM Gateway locally.
# Usage:  ./start-gateway.sh
#         ./start-gateway.sh --port 9000

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
PKG_DIR="$SCRIPT_DIR/packages/llm-gateway"
DIST_CLI="$PKG_DIR/dist/cli.js"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

# Load .env (skip comments and blank lines)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Gateway auth key defaults to "local-dev-key" if not set
export STACKBILT_GATEWAY_KEY="${STACKBILT_GATEWAY_KEY:-local-dev-key}"

cd "$SCRIPT_DIR"

if [[ ! -f "$DIST_CLI" ]]; then
  npm run build --workspace packages/llm-gateway >/dev/null
fi

if [[ -f "$DIST_CLI" ]]; then
  exec node "$DIST_CLI" start "$@"
fi

if [[ -x "$SCRIPT_DIR/node_modules/.bin/tsx" ]]; then
  exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$PKG_DIR/src/cli.ts" start "$@"
fi

exec npx --prefix "$SCRIPT_DIR" tsx "$PKG_DIR/src/cli.ts" start "$@"
