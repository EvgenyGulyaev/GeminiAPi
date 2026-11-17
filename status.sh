#!/usr/bin/env bash
# Show gemini-bridge stack status. Usage: ./status.sh
set -uo pipefail
cd "$(dirname "$0")"

check() {
  local pat="$1" name="$2"
  local pid
  pid=$(pgrep -f "$pat" | head -1)
  if [[ -n "$pid" ]]; then
    local up
    up=$(ps -p "$pid" -o etime= | tr -d ' ')
    printf '  %-18s RUNNING  pid=%s up=%s\n' "$name" "$pid" "$up"
  else
    printf '  %-18s stopped\n' "$name"
  fi
}

echo "gemini-bridge stack:"
check "python.* -m gemini_bridge" "bridge"
check "scripts/proxy_forwarder.py" "proxy-forwarder"
check "scripts/login_via_proxy.py" "login-browser"

if curl -s -m 4 localhost:8787/health >/dev/null 2>&1; then
  echo "  bridge health:     OK (http://127.0.0.1:8787)"
else
  echo "  bridge health:     not responding"
fi
[[ -f cookies.json ]] && echo "  cookies.json:      present" || echo "  cookies.json:      MISSING"
[[ -n "${GEMINI_PROXY:-}" ]] && echo "  GEMINI_PROXY:      set" || echo "  GEMINI_PROXY:      unset (direct)"