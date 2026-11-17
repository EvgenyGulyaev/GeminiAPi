#!/usr/bin/env bash
# One-shot installer: gemini-bridge (Python) + bb-plugin-gemini-web (ACP provider).
# Usage: ./install.sh [--no-cookies]
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- prerequisites ---
say "Checking prerequisites"
for cmd in uv node bb; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found on PATH (install it first)"
done
echo "uv $(uv --version | awk '{print $2}'), node $(node --version), bb ok"

# --- bridge (Python) ---
say "Installing gemini-bridge dependencies (uv sync)"
uv sync

# --- bb plugin (ACP provider) ---
say "Building + installing bb-plugin-gemini-web"
cd "$ROOT/bb-plugin-gemini-web"
npm install --no-audit --no-fund
bb plugin build
bb plugin install . --yes

# adapter must be on PATH (bb spawns it by name)
say "Linking gemini-acp onto PATH"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$ROOT/bb-plugin-gemini-web/bin/gemini-acp.mjs" "$BIN_DIR/gemini-acp"
chmod +x "$ROOT/bb-plugin-gemini-web/bin/gemini-acp.mjs"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "gemini-acp -> $BIN_DIR/gemini-acp (on PATH)" ;;
  *) echo "WARNING: $BIN_DIR is not on PATH. Add it: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
cd "$ROOT"

# --- cookies ---
if [[ "${1:-}" != "--no-cookies" ]]; then
  say "Extracting Gemini cookies from Chrome (approve the Keychain dialog)"
  echo "Chrome must be logged in to https://gemini.google.com"
  uv run python scripts/extract_cookies.py || \
    echo "Cookie extraction skipped/failed — run later: uv run python scripts/extract_cookies.py"
fi

say "Done"
cat <<'EOF'
Next steps:
  1. Start the bridge:           ./start.sh
     (residential proxy needed if your IP is hosting/datacenter:
      GEMINI_PROXY="socks5h://user:pass@host:port" ./start.sh)
  2. Restart bb, then pick provider "Gemini Web" -> gemini-4-argon.

Re-extract cookies anytime:      uv run python scripts/extract_cookies.py
Run bridge tests:                uv run pytest -q
EOF