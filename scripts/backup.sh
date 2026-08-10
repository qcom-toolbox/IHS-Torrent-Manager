#!/usr/bin/env bash
#
# Backs up the Torrent Manager database, configuration, and secrets.
# Deliberately does NOT include downloaded torrent data -- that lives on
# its own volume and is typically far too large for a routine config
# backup; back it up separately (e.g. filesystem snapshot, rsync) if needed.
#
# Usage:
#   sudo ./scripts/backup.sh [output-directory]
#
# Suitable for cron, e.g. a nightly backup:
#   0 3 * * * root /opt/torrent-manager/scripts/backup.sh /var/backups/torrent-manager

set -euo pipefail

CONFIG_DIR="/etc/torrent-manager"
DATA_DIR="/var/lib/torrent-manager"
OUT_DIR="${1:-/var/backups/torrent-manager}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "This script must be run as root (it reads secrets in $CONFIG_DIR)." >&2
  exit 1
fi

if [[ ! -d "$CONFIG_DIR" || ! -d "$DATA_DIR" ]]; then
  echo "Torrent Manager does not appear to be installed ($CONFIG_DIR / $DATA_DIR missing)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

timestamp="$(date -u +%Y%m%d-%H%M%S)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "==> Snapshotting database (using SQLite's online backup, safe while services are running)..."
mkdir -p "$work_dir/data"
sqlite3 "$DATA_DIR/torrent-manager.sqlite" ".backup '$work_dir/data/torrent-manager.sqlite'"

echo "==> Copying configuration and secrets..."
mkdir -p "$work_dir/config"
cp -a "$CONFIG_DIR"/. "$work_dir/config/"

archive_path="$OUT_DIR/torrent-manager-backup-${timestamp}.tar.gz"
tar -C "$work_dir" -czf "$archive_path" data config
chmod 600 "$archive_path"

echo "==> Backup written to $archive_path"
echo "    Contents: database snapshot + $CONFIG_DIR (env files, secrets, install state)"
echo "    NOT included: torrent data. Back that up separately if desired."
