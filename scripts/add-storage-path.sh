#!/usr/bin/env bash
#
# IHS Torrent Manager - grant an additional disk to the torrent services
#
#   sudo ./scripts/add-storage-path.sh /mnt/disk2/torrents "Disk 2"
#
# The management panel, worker, and download portal run under a hardened
# systemd sandbox (ProtectSystem=strict + an explicit ReadWritePaths/
# ReadOnlyPaths allowlist) -- a path outside that allowlist is denied at
# the kernel level regardless of ordinary Unix file permissions. Adding a
# storage location purely through the web UI can only fail loudly and
# tell you to run this script; this is what actually grants the access:
#
#   1. Creates the directory if it doesn't exist yet, owned by the
#      service user.
#   2. Appends the path to ReadWritePaths= in the qBittorrent, panel and
#      worker units (qBittorrent is the process that actually writes
#      torrent data to disk), and to ReadOnlyPaths= in the portal unit
#      (the portal never writes torrent data, only reads completed files
#      -- same asymmetry as the default download directory already has).
#   3. Reloads systemd and restarts all four services.
#   4. Registers the path as a storage location in the database, so it
#      immediately shows up as selectable when uploading a new torrent,
#      and so future `install.sh`/`upgrade.sh`/`fix-install.sh` runs keep
#      granting access to it when they regenerate the unit files.
#
# Safe to re-run for the same path (idempotent) and safe to run while the
# services are handling other traffic (brief restart only).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../install.sh
TM_SOURCED=1 source "$REPO_ROOT/install.sh"

require_root

if [[ $# -lt 1 ]]; then
  echo "Usage: sudo $0 <absolute-path> [label]" >&2
  exit 1
fi

RAW_PATH="$1"
LABEL="${2:-$(basename "$RAW_PATH")}"

if [[ "$RAW_PATH" != /* ]]; then
  die "Path must be absolute (got: $RAW_PATH)"
fi
NEW_PATH="$RAW_PATH"

if ! detect_existing_installation; then
  die "No existing installation found at $STATE_FILE. Run 'sudo ./install.sh' first."
fi
load_state

header "Granting Storage Access: $NEW_PATH"

if [[ ! -d "$NEW_PATH" ]]; then
  log "Directory does not exist yet -- creating it."
  mkdir -p "$NEW_PATH"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$NEW_PATH"
ok "Directory ready and owned by $SERVICE_USER"

append_sandbox_path() {
  # append_sandbox_path <unit-file> <directive-name>
  local unit_file="$1" directive="$2"
  if [[ ! -f "$unit_file" ]]; then
    warn "Unit file not found, skipping: $unit_file"
    return
  fi
  if grep -qE "^${directive}=.*(^|[[:space:]])${NEW_PATH//\//\\/}([[:space:]]|\$)" "$unit_file"; then
    ok "$(basename "$unit_file"): $directive already includes $NEW_PATH"
    return
  fi
  if grep -q "^${directive}=" "$unit_file"; then
    sed -i "s#^${directive}=.*#& ${NEW_PATH}#" "$unit_file"
  else
    # Directive doesn't exist in this unit yet -- add it under [Service].
    sed -i "/^\[Service\]/a ${directive}=${NEW_PATH}" "$unit_file"
  fi
  ok "$(basename "$unit_file"): added $NEW_PATH to $directive"
}

append_sandbox_path "$SYSTEMD_DIR/qbittorrent-nox.service" "ReadWritePaths"
append_sandbox_path "$SYSTEMD_DIR/ihs-torrent-manager.service" "ReadWritePaths"
append_sandbox_path "$SYSTEMD_DIR/ihs-torrent-manager-worker.service" "ReadWritePaths"
append_sandbox_path "$SYSTEMD_DIR/ihs-torrent-manager-portal.service" "ReadOnlyPaths"

systemctl daemon-reload
systemctl restart qbittorrent-nox ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal
ok "systemd reloaded, services restarted"

log "Waiting for qBittorrent to come back up..."
if ! wait_for_qbittorrent_webui; then
  fail "qBittorrent did not come back up after the restart."
  echo "  Diagnostics: systemctl status qbittorrent-nox ; journalctl -u qbittorrent-nox -n 50"
  exit 1
fi
ok "qBittorrent is responding"

log "Waiting for the management panel to come back up..."
if ! wait_for_http_ok "http://127.0.0.1:${APP_PORT}/api/health"; then
  fail "Management panel did not come back up after the restart."
  echo "  Diagnostics: systemctl status ihs-torrent-manager ; journalctl -u ihs-torrent-manager -n 50"
  exit 1
fi
ok "Management panel is responding"

log "Registering the storage location..."
( cd "$APP_DIR" && sudo -u "$SERVICE_USER" env DATABASE_PATH="$DATA_DIR/ihs-torrent-manager.sqlite" \
    node scripts/register-storage-location.js "$NEW_PATH" "$LABEL" )

header "Done"
echo "\"$LABEL\" ($NEW_PATH) is now available as a storage location when uploading torrents."
