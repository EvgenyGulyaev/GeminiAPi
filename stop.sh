#!/usr/bin/env bash
# Stop gemini-bridge and the proxy forwarder. Usage: ./stop.sh [--all]
set -uo pipefail
cd "$(dirname "$0")"

stop() {
  local pat="$1" name="$2"
  if pgrep -f "$pat" >/dev/null 2>&1; then
    pkill -f "$pat" 2>/dev/null
    sleep 1
    pgrep -f "$pat" >/dev/null 2>&1 && pkill -9 -f "$pat" 2>/dev/null
    echo "stopped: $name"
  else
    echo "not running: $name"
  fi
}

stop "python.* -m gemini_bridge" "gemini-bridge"
stop "scripts/proxy_forwarder.py" "proxy-forwarder"
if [[ "${1:-}" == "--all" ]]; then
  stop "scripts/login_via_proxy.py" "login-browser"
  stop "scripts/capture_argon_header.py" "capture-browser"
fi
echo "done"