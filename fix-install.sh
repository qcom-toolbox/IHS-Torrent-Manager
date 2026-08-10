#!/usr/bin/env bash
#
# IHS Torrent Manager - repair an existing, already-attempted installation
#
#   sudo ./fix-install.sh
#
# Thin wrapper around install.sh's repair path: re-deploys the current
# checkout's code, re-renders and reinstalls the systemd unit files (so
# any fix shipped since your last install actually gets applied --
# e.g. a bad hardening directive or a unit-ordering bug), re-verifies/
# reconfigures qBittorrent's WebUI credentials if needed, and restarts
# every service. It does not touch the admin account, the portal
# password, users, or torrent data. Fully non-interactive.
#
# Use this after `git pull` when a previous install run hit a problem
# (services crash-looping, qBittorrent not reachable, etc.) instead of
# re-running the full interactive sudo ./install.sh from scratch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./install.sh
TM_SOURCED=1 source "$SCRIPT_DIR/install.sh"

require_root
detect_system

if detect_existing_installation; then
  run_repair
else
  die "No existing installation found at $STATE_FILE. Run 'sudo ./install.sh' to install for the first time."
fi
