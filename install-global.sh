#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.local/bin"
TARGET="${TARGET_DIR}/stackbilt-gw"
MARKER="stackbilt-gateway"

# --- symlinks ---
mkdir -p "$TARGET_DIR"
ln -sf "$SCRIPT_DIR/gateway.sh" "$TARGET"
chmod +x "$SCRIPT_DIR/gateway.sh"
echo "[install] $TARGET -> $SCRIPT_DIR/gateway.sh"

BILDY_TARGET="${TARGET_DIR}/bildy"
ln -sf "$SCRIPT_DIR/bildy.mjs" "$BILDY_TARGET"
chmod +x "$SCRIPT_DIR/bildy.mjs"
echo "[install] $BILDY_TARGET -> $SCRIPT_DIR/bildy.mjs"

# --- detect shell profile ---
detect_profile() {
  if [[ "${SHELL:-}" == */zsh ]]; then
    echo "$HOME/.zshrc"
  elif [[ -f "$HOME/.bashrc" ]]; then
    echo "$HOME/.bashrc"
  elif [[ -f "$HOME/.bash_profile" ]]; then
    echo "$HOME/.bash_profile"
  else
    echo "$HOME/.bashrc"
  fi
}

# --- wire shell profile (idempotent) ---
wire_shell() {
  local profile
  profile="$(detect_profile)"

  if grep -qF "$MARKER" "$profile" 2>/dev/null; then
    echo "[install] Shell already wired in $profile"
    return 0
  fi

  cat >> "$profile" <<EOF

# >>> ${MARKER} >>>
export PATH="\$HOME/.local/bin:\$PATH"
eval "\$(stackbilt-gw shell-init 2>/dev/null)"
# <<< ${MARKER} <<<
EOF

  echo "[install] Wired shell in $profile"
}

wire_shell

PROFILE="$(detect_profile)"
echo ""
echo "Setup complete. To activate now:"
echo "  source $PROFILE"
echo ""
echo "Or just restart your terminal. Then from any project:"
echo "  bildy     # pick Claude or Codex, gateway auto-starts"
echo "  claude    # native Claude Code (no gateway)"
echo "  codex     # native Codex (no gateway)"
echo "  claude-gw # Claude Code via gateway helper (if shell-init is loaded)"
echo "  codex-gw  # Codex via gateway helper (if shell-init is loaded)"
