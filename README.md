# IHS Torrent Manager

A self-hosted torrent management platform for a private Debian server: a
full authenticated management panel backed by qBittorrent, plus a separate,
deliberately minimal password-protected download portal for handing out
finished downloads.

This is a real application with a real backend, a real database, real
authentication, and a real qBittorrent integration — not a mockup. See
[docs/security.md](docs/security.md) for the threat model and
[docs/installation.md](docs/installation.md) for what to expect from the
installer.

## What this is

Two independent web interfaces, one shared backend:

- **Management panel** — username/password login, per-user torrent
  ownership, admin user management, upload/pause/resume/stop/delete
  torrents, live progress and disk-space monitoring.
- **Download portal** — a single shared password gates a simple page
  listing only *completed* downloads, with safe single-file or
  zipped-directory downloads. It has no access to qBittorrent credentials,
  the management API, or any file outside the torrent directory.

## Architecture

```
                    ┌────────────────────┐
                    │   qBittorrent-nox   │  WebUI bound to 127.0.0.1 only
                    │   (Web API backend) │  -- never exposed publicly
                    └─────────┬────────────┘
                              │ HTTP API (localhost)
                 ┌────────────┴─────────────┐
                 │                           │
        ┌────────▼────────┐        ┌─────────▼────────┐
        │  Background      │        │  Management       │
        │  sync worker     │───────▶│  panel (app)       │
        │  (polls qBt,     │  reads │  Express API +     │
        │  writes DB)      │  DB    │  React frontend    │
        └────────┬─────────┘        └─────────┬──────────┘
                 │  writes                     │ reads
                 └─────────────┬───────────────┘
                                │
                        ┌───────▼────────┐        ┌────────────────────┐
                        │  SQLite         │◀──────▶│  Download portal    │
                        │  database       │  reads │  (separate process, │
                        │  (WAL mode)     │  only  │  no qBt credentials) │
                        └─────────────────┘        └─────────────────────┘
```

Three independent Node.js processes (management panel, sync worker,
download portal) plus qBittorrent-nox, each its own systemd service, each
with its own least-privilege environment file. The browser-facing UI never
talks to qBittorrent directly — only the app and worker do, over localhost.

## Features

- Argon2id password hashing, server-side sessions (SQLite-backed, survive
  restarts), CSRF protection, per-route rate limiting, DB-backed
  brute-force login protection.
- Every torrent operation is authorized server-side against the
  authenticated user's ID — normal users can never see or control another
  user's torrents, admins can manage everything.
- `.torrent` uploads are validated as real bencoded torrent files (not just
  by extension) before being handed to qBittorrent; filenames and torrent
  content paths are sanitized and confined to the configured download
  directory (path traversal / symlink-escape resistant).
- Background worker continuously reconciles qBittorrent's real state into
  the database — the UI never queries qBittorrent directly, and both the
  app and qBittorrent recover cleanly from independent restarts.
- Real-time disk space widget (from the actual filesystem backing the
  torrent directory, not estimates) with configurable warning/critical/
  block thresholds; new downloads are refused when space is critically low.
- Dark mode, responsive layout, admin dashboard with fleet-wide stats and
  audit log.
- Interactive Debian installer that detects an existing install and offers
  upgrade / repair / reconfigure / uninstall instead of overwriting it.

## Supported Debian versions

Debian 11 (bullseye), 12 (bookworm), and 13 (trixie), on `amd64` or
`arm64`. Other Debian-based distributions may work but are not tested.

## Requirements

- A dedicated (virtual) machine or container running one of the Debian
  releases above, with root/sudo access.
- At least 768 MB RAM (2 GB+ recommended) and a few GB of free disk space
  for the application itself, separate from wherever torrent data will
  live.
- Outbound internet access during installation (to fetch Node.js,
  qBittorrent-nox, and npm packages).

## Installation

```bash
git clone https://github.com/qcom-toolbox/IHS-Torrent-Manager.git
cd IHS-Torrent-Manager
sudo ./install.sh
```

The installer is interactive: it detects your Debian version, architecture,
RAM and disk space; asks for install paths, ports, and credentials
(passwords are never echoed to the terminal); installs Node.js,
qBittorrent-nox and all dependencies; builds the application; creates a
dedicated system user; generates secrets; runs database migrations;
creates your administrator account; configures qBittorrent's WebUI bound
to `127.0.0.1` only; installs and starts systemd services; optionally
configures UFW and an nginx/Caddy reverse proxy; and finishes with a set of
`[OK]`/`[FAIL]` health checks. See [docs/installation.md](docs/installation.md)
for the full walkthrough and what each step does.

If an installation already exists, running `sudo ./install.sh` again offers
**Upgrade / Repair / Reconfigure / Uninstall / Abort** instead of
overwriting anything.

## Documentation

- [Installation](docs/installation.md)
- [Configuration](docs/configuration.md)
- [Administration](docs/administration.md) — user management, torrent
  management, the download portal
- [Security](docs/security.md) — threat model, what's enforced where
- [Backup & restore](docs/backup.md)
- [Troubleshooting](docs/troubleshooting.md)

## Technology

- **Backend**: Node.js + TypeScript + Express, structured as an npm
  workspace (`shared`, `app`, `worker`, `portal`, `frontend`).
- **Database**: SQLite (via `better-sqlite3`, WAL mode) — a single
  embedded file, no separate database service to secure, back up, or
  expose. Schema managed by a small numbered-migration runner
  (`migrations/`).
- **Torrent backend**: qBittorrent-nox, driven entirely through its
  official Web API — this project does not implement the BitTorrent
  protocol itself.
- **Frontend**: React + TypeScript + Tailwind CSS (Vite build), served as
  static assets by the management panel's Express server.
- **Download portal**: a intentionally small separate Express + EJS app.
- **Process management**: systemd, one unit per service, each running as
  a dedicated non-root system user with a hardened sandboxed unit file.

## Updating

```bash
cd IHS-Torrent-Manager
git pull
sudo ./upgrade.sh
```

(equivalent to `sudo ./install.sh` and choosing "Upgrade" when it detects
the existing installation). Your database, torrent data, users, and
secrets are preserved.

## Uninstalling

```bash
sudo ./uninstall.sh
```

Every category (systemd services, qBittorrent, application code, database,
configuration, system user, torrent data) is removed independently with
its own confirmation. Torrent data additionally requires typing a literal
confirmation phrase — it is never deleted as a side effect of removing
anything else.

## License

[MIT](LICENSE)
