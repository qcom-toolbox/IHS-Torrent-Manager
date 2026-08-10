#!/usr/bin/env bash
#
# Standalone health check for an existing installation. Safe to run anytime,
# including via cron/monitoring. Does not require root (systemctl --user
# checks and public health endpoints only), though some detail requires it.
#
# Usage: ./scripts/healthcheck.sh

set -uo pipefail

CONFIG_DIR="/etc/ihs-torrent-manager"
STATE_FILE="$CONFIG_DIR/install.conf"

if [[ -t 1 ]]; then C_GREEN='\033[32m'; C_RED='\033[31m'; C_RESET='\033[0m'; else C_GREEN=''; C_RED=''; C_RESET=''; fi
ok()   { printf '%b\n' "${C_GREEN}[OK]${C_RESET} $*"; }
fail() { printf '%b\n' "${C_RED}[FAIL]${C_RESET} $*"; STATUS=1; }
STATUS=0

APP_PORT=3000
PORTAL_PORT=3001
QBT_PORT=8080
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

for svc in qbittorrent-nox ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    ok "$svc is running"
  else
    fail "$svc is not running (systemctl status $svc)"
  fi
done

if curl -fs "http://127.0.0.1:${QBT_PORT}/api/v2/app/version" >/dev/null 2>&1; then ok "qBittorrent WebUI responding"; else fail "qBittorrent WebUI not responding on port $QBT_PORT"; fi
if curl -fs "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then ok "Management panel responding"; else fail "Management panel not responding on port $APP_PORT"; fi
if curl -fs "http://127.0.0.1:${PORTAL_PORT}/health" >/dev/null 2>&1; then ok "Download portal responding"; else fail "Download portal not responding on port $PORTAL_PORT"; fi

if (( STATUS != 0 )); then
  echo
  echo "Diagnostics:"
  echo "  journalctl -u ihs-torrent-manager -n 100"
  echo "  journalctl -u ihs-torrent-manager-worker -n 100"
  echo "  journalctl -u ihs-torrent-manager-portal -n 100"
  echo "  journalctl -u qbittorrent-nox -n 100"
fi

exit "$STATUS"
