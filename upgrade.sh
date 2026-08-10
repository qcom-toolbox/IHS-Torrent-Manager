#!/usr/bin/env bash
#
# Torrent Manager - upgrade in place
#
#   sudo ./upgrade.sh
#
# Thin wrapper around install.sh's upgrade path: deploys the current
# checkout's code, runs migrations, and restarts services, while
# preserving the database, torrent data, users, and secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./install.sh
TM_SOURCED=1 source "$SCRIPT_DIR/install.sh"

require_root
detect_system

if detect_existing_installation; then
  run_upgrade
else
  die "No existing installation found at $STATE_FILE. Run 'sudo ./install.sh' to install for the first time."
fi
