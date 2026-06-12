#!/usr/bin/env bash
set -euo pipefail

remove_target() {
  local target="$1"
  if [[ -L "$target" || -f "$target" ]]; then
    rm -f "$target"
    echo "Removed: $target"
  else
    echo "Not installed: $target"
  fi
}

remove_target "${HOME}/.local/bin/stackbilt-gw"
remove_target "${HOME}/.local/bin/bildy"
