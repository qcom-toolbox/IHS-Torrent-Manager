# Installation

## Requirements

- Debian 11 (bullseye), 12 (bookworm), or 13 (trixie); `amd64` or `arm64`.
- Root/sudo access.
- At least 768 MB RAM (2 GB+ recommended), a few GB free disk space for the
  application (separate from the torrent storage volume).
- Outbound internet access during install (Node.js, qBittorrent-nox, and
  npm packages are downloaded).

## Quick start

```bash
git clone https://github.com/qcom-toolbox/torrent-manager.git
cd torrent-manager
sudo ./install.sh
```

## What the installer does, step by step

1. **System detection** — reads `/etc/os-release`, `dpkg --print-architecture`,
   `/proc/meminfo`, and `df` to confirm Debian, architecture, RAM, and disk
   space are sufficient. Warns (with a chance to continue) on unsupported
   combinations rather than silently proceeding.
2. **Existing installation check** — if `/etc/torrent-manager/install.conf`
   exists, you're dropped into the Upgrade/Repair/Reconfigure/Uninstall/
   Abort menu instead of a fresh install.
3. **Interactive prompts**:
   ```
   Application directory [/opt/torrent-manager]:
   Download directory [/srv/torrents]:
   Application port [3000]:
   Download portal port [3001]:
   qBittorrent WebUI port [8080]:
   Admin username:
   Admin password:            (hidden, confirmed)
   Download portal password:  (hidden, confirmed)
   ```
4. **Package installation** — `build-essential`, `python3` (needed to
   compile the SQLite driver), `sqlite3`, `qbittorrent-nox`, and Node.js 20
   LTS (from NodeSource if the distro's own package is older).
5. **System user & directories** — creates a dedicated, unprivileged
   `torrent-manager` system user (no login shell) and the application,
   data, download, and config directories with restrictive ownership.
6. **Deploy & build** — copies the repository into the application
   directory (or builds in place if already running from there), installs
   npm dependencies, compiles TypeScript, and builds the React frontend.
7. **Configuration & secrets** — generates a random session secret per
   service and a random qBittorrent WebUI username/password, and writes
   three separate environment files under `/etc/torrent-manager/`
   (`app.env`, `worker.env`, `portal.env`) — the portal's file deliberately
   never contains qBittorrent credentials.
8. **Database** — runs migrations against a fresh SQLite database, creates
   your administrator account (Argon2id-hashed), and stores the download
   portal password (also Argon2id-hashed).
9. **qBittorrent bootstrap** — writes an initial `qBittorrent.conf` binding
   the WebUI to `127.0.0.1` only, starts the service, and authenticates
   through the real WebUI API (using qBittorrent's own first-run default or
   generated temporary password) to set the permanent WebUI
   username/password the app will use — qBittorrent hashes its own
   password, this script never reimplements that.
10. **systemd** — installs `torrent-manager.service`,
    `torrent-manager-worker.service`, `torrent-manager-portal.service`, and
    `qbittorrent-nox.service`, enables them at boot, and starts them.
11. **Firewall** — if UFW is installed, offers to open the panel and portal
    ports; never touches an unrelated existing ruleset without asking, and
    never opens the qBittorrent WebUI port (it stays on localhost).
12. **Reverse proxy (optional)** — nginx or Caddy, if you provide a domain.
13. **Health checks** — verifies each systemd service is active, each HTTP
    health endpoint responds, the database file exists, and that the admin
    account can actually log in — printing `[OK]`/`[FAIL]` per check. On
    failure it prints the exact `systemctl status` / `journalctl` commands
    to investigate.
14. **Summary** — prints the panel/portal URLs, install paths, and the
    commands to check status, view logs, upgrade, or uninstall.

## Non-interactive re-runs

Running `sudo ./install.sh` again after a successful install detects
`/etc/torrent-manager/install.conf` and offers:

```
1) Upgrade      - deploy the latest code, run migrations, keep all data
2) Repair       - reinstall dependencies/services without touching accounts
3) Reconfigure  - change ports/passwords
4) Uninstall    - remove the application (with granular data options)
5) Abort
```

None of these ever delete torrent data; only `uninstall.sh`'s dedicated,
phrase-confirmed step does that (see [backup.md](backup.md) and the main
README's uninstall section).

## A note on the database

The installer only offers SQLite. This project's data model (users,
torrents, sessions, audit log) fits comfortably in an embedded database,
and SQLite removes an entire class of production concerns — no separate
service to harden, no database port to accidentally expose, no extra
credentials to manage, and one fewer moving part to keep alive across
reboots. If your deployment later needs a client/server database, the
migration/model layer (`shared/src/db`) is a single, isolated place to swap
it out.
