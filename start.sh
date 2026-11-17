#!/usr/bin/env bash
# Start gemini-bridge. Usage: ./start.sh [-b|--background]
# Env passthrough: GEMINI_PROXY, GEMINI_BRIDGE_PORT, GEMINI_BRIDGE_HOST, GEMINI_COOKIE_FILE.
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] && set -a && source .env && set +a

BG=0
for arg in "$@"; do
  case "$arg" in
    -b|--background) BG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -f cookies.json && -z "${GEMINI_1PSID:-}" ]]; then
  echo "No cookies.json — extracting from Chrome first..."
  uv run python scripts/extract_cookies.py
fi

if [[ -n "${GEMINI_PROXY:-}" ]]; then
  echo "Proxy: $GEMINI_PROXY"
else
  echo "Proxy: off (direct). Hosting/datacenter IP may be LOCATION_REJECTED by Gemini."
fi

if [[ "$BG" == 1 ]]; then
  LOG="${GEMINI_BRIDGE_LOG:-/tmp/gemini-bridge.log}"
  nohup uv run python -m gemini_bridge >"$LOG" 2>&1 &
  echo "gemini-bridge started in background (pid $!), log: $LOG"
  echo "Stop: pkill -f gemini_bridge"
else
  exec uv run python -m gemini_bridge
fi