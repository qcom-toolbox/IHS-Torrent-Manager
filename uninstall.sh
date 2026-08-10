#!/usr/bin/env bash
#
# IHS Torrent Manager - uninstaller
#
#   sudo ./uninstall.sh
#
# Every category below is removed only after an explicit, separate
# confirmation. Torrent data in particular requires typing a literal
# confirmation phrase -- it is never deleted as a side effect of removing
# anything else.

set -euo pipefail

CONFIG_DIR="/etc/ihs-torrent-manager"
STATE_FILE="$CONFIG_DIR/install.conf"
SERVICE_USER="ihs-torrent-manager"
DATA_DIR="/var/lib/ihs-torrent-manager"

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_RED='\033[31m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_BLUE='\033[34m'
else
  C_RESET=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi
log()  { printf '%b\n' "${C_BLUE}==>${C_RESET} $*"; }
ok()   { printf '%b\n' "${C_GREEN}[OK]${C_RESET} $*"; }
warn() { printf '%b\n' "${C_YELLOW}[WARN]${C_RESET} $*"; }
die()  { printf '%b\n' "${C_RED}[FAIL]${C_RESET} $*"; exit 1; }

confirm() {
  local answer
  read -r -p "$1 [y/N]: " answer || true
  [[ "$answer" =~ ^[Yy]$ ]]
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "This script must be run as root, e.g.: sudo ./uninstall.sh"
fi

APP_DIR="/opt/ihs-torrent-manager"
DOWNLOAD_DIR="/srv/torrents"
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

echo
printf '%b\n' "${C_BOLD}========================================${C_RESET}"
printf '%b\n' "${C_BOLD} IHS Torrent Manager Uninstall${C_RESET}"
printf '%b\n' "${C_BOLD}========================================${C_RESET}"
echo
echo "Each item below is removed independently and only with your explicit confirmation."
echo "Detected paths: app=$APP_DIR  data=$DATA_DIR  config=$CONFIG_DIR  downloads=$DOWNLOAD_DIR"
echo

# 1. Stop and remove systemd services
if confirm "Stop services and remove systemd unit files (ihs-torrent-manager, worker, portal)?"; then
  systemctl stop ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal 2>/dev/null || true
  systemctl disable ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal 2>/dev/null || true
  rm -f /etc/systemd/system/ihs-torrent-manager.service \
        /etc/systemd/system/ihs-torrent-manager-worker.service \
        /etc/systemd/system/ihs-torrent-manager-portal.service
  systemctl daemon-reload
  ok "IHS Torrent Manager systemd services removed"
else
  warn "Skipped: systemd services left in place"
fi

# 2. Remove qBittorrent
if confirm "Stop and remove qBittorrent (qbittorrent-nox package + its systemd unit)? Torrent DATA is handled separately below."; then
  systemctl stop qbittorrent-nox 2>/dev/null || true
  systemctl disable qbittorrent-nox 2>/dev/null || true
  rm -f /etc/systemd/system/qbittorrent-nox.service
  systemctl daemon-reload
  if confirm "Also purge the qbittorrent-nox APT package?"; then
    apt-get remove -y -qq qbittorrent-nox >/dev/null 2>&1 || true
    ok "qbittorrent-nox package removed"
  fi
  ok "qBittorrent service removed"
else
  warn "Skipped: qBittorrent left in place"
fi

# 3. Remove application code
if confirm "Remove application code directory ($APP_DIR)?"; then
  rm -rf "$APP_DIR"
  ok "Application code removed"
else
  warn "Skipped: application code left in place"
fi

# 4. Remove database + app-managed data (excludes torrent downloads)
if confirm "Remove the database and application data ($DATA_DIR, includes qBittorrent's own config/state)? Torrent DATA in the download directory is not affected."; then
  rm -rf "$DATA_DIR"
  ok "Database and application data removed"
else
  warn "Skipped: database and application data left in place at $DATA_DIR"
fi

# 5. Remove configuration (env files, secrets, install state)
if confirm "Remove configuration and secrets ($CONFIG_DIR)?"; then
  rm -rf "$CONFIG_DIR"
  ok "Configuration removed"
else
  warn "Skipped: configuration left in place at $CONFIG_DIR"
fi

# 6. Remove system user
if id "$SERVICE_USER" >/dev/null 2>&1; then
  if confirm "Remove the '$SERVICE_USER' system user?"; then
    userdel "$SERVICE_USER" 2>/dev/null || true
    ok "System user '$SERVICE_USER' removed"
  else
    warn "Skipped: system user left in place"
  fi
fi

# 7. Torrent data -- separate, explicit, phrase-confirmed
echo
warn "The download directory ($DOWNLOAD_DIR) may contain torrent data that took a long time to download."
if confirm "Do you want to review deleting torrent DATA in $DOWNLOAD_DIR?"; then
  if [[ -d "$DOWNLOAD_DIR" ]]; then
    du -sh "$DOWNLOAD_DIR" 2>/dev/null || true
  fi
  echo
  echo "To permanently delete all files under $DOWNLOAD_DIR, type exactly:  DELETE MY TORRENTS"
  read -r -p "> " phrase || true
  if [[ "$phrase" == "DELETE MY TORRENTS" ]]; then
    rm -rf "${DOWNLOAD_DIR:?}"/*
    ok "Torrent data deleted from $DOWNLOAD_DIR"
  else
    warn "Confirmation phrase did not match. Torrent data was NOT deleted."
  fi
else
  warn "Torrent data left in place at $DOWNLOAD_DIR"
fi

echo
ok "Uninstall steps complete."
