#!/usr/bin/env bash
#
# Restores a backup created by scripts/backup.sh: database + configuration.
# Stops services first, restores, then restarts. Torrent data is not part
# of these backups and is not touched.
#
# Usage:
#   sudo ./scripts/restore.sh /var/backups/ihs-torrent-manager/ihs-torrent-manager-backup-20260101-030000.tar.gz

set -euo pipefail

CONFIG_DIR="/etc/ihs-torrent-manager"
DATA_DIR="/var/lib/ihs-torrent-manager"
SERVICE_USER="ihs-torrent-manager"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "This script must be run as root." >&2
  exit 1
fi

archive_path="${1:-}"
if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  echo "Usage: sudo ./scripts/restore.sh <path-to-backup.tar.gz>" >&2
  exit 1
fi

read -r -p "This will stop IHS Torrent Manager services and overwrite the current database and configuration. Continue? [y/N]: " answer
[[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "==> Extracting backup..."
tar -C "$work_dir" -xzf "$archive_path"

if [[ ! -f "$work_dir/data/ihs-torrent-manager.sqlite" || ! -d "$work_dir/config" ]]; then
  echo "Backup archive does not look like a IHS Torrent Manager backup (missing data/ or config/)." >&2
  exit 1
fi

echo "==> Stopping services..."
systemctl stop ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal 2>/dev/null || true

echo "==> Restoring database..."
mkdir -p "$DATA_DIR"
cp "$work_dir/data/ihs-torrent-manager.sqlite" "$DATA_DIR/ihs-torrent-manager.sqlite"
rm -f "$DATA_DIR/ihs-torrent-manager.sqlite-wal" "$DATA_DIR/ihs-torrent-manager.sqlite-shm"

echo "==> Restoring configuration..."
mkdir -p "$CONFIG_DIR"
cp -a "$work_dir/config/." "$CONFIG_DIR/"

chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chown root:"$SERVICE_USER" "$CONFIG_DIR"/*.env "$CONFIG_DIR/install.conf" 2>/dev/null || true
chmod 640 "$CONFIG_DIR"/*.env 2>/dev/null || true

echo "==> Restarting services..."
systemctl start ihs-torrent-manager-worker ihs-torrent-manager ihs-torrent-manager-portal

echo "==> Restore complete. Check status with: systemctl status ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal"
