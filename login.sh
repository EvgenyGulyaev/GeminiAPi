#!/usr/bin/env bash
# Login to Gemini through the residential proxy (forwarder started on demand).
# Usage: GEMINI_PROXY="socks5h://user:pass@host:port" ./login.sh
set -euo pipefail
cd "$(dirname "$0")"
[[ -f .env ]] && set -a && source .env && set +a

if [[ -z "${GEMINI_PROXY:-}" ]]; then
  echo "Set GEMINI_PROXY (socks5h://user:pass@host:port) in env or .env"; exit 1
fi

# start forwarder on demand (browsers can't SOCKS5-auth)
if ! pgrep -f "scripts/proxy_forwarder.py" >/dev/null 2>&1; then
  echo "starting proxy forwarder (127.0.0.1:10800)..."
  nohup uv run python scripts/proxy_forwarder.py > /tmp/proxy-fwd.log 2>&1 &
  sleep 3
fi

echo "opening login browser via proxy..."
GEMINI_PROXY="socks5://127.0.0.1:${LOCAL_PROXY_PORT:-10800}" \
  uv run --with playwright python scripts/login_via_proxy.py

echo "login done. Forwarder left running for browser proxy use; stop with ./stop.sh"