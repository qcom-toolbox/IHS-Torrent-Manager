# Troubleshooting

## First step: run the health check

```bash
sudo /opt/ihs-torrent-manager/scripts/healthcheck.sh
```

Or check everything manually:

```bash
systemctl status ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal qbittorrent-nox
journalctl -u ihs-torrent-manager -n 100
journalctl -u ihs-torrent-manager-worker -n 100
journalctl -u ihs-torrent-manager-portal -n 100
journalctl -u qbittorrent-nox -n 100
```

## Installer failed

The installer never hides a failure — it stops with a `[FAIL]` line and the
exact diagnostic commands to run. Common causes:

- **Insufficient RAM/disk** — the installer checks these up front and
  refuses to proceed; free up space or resize the VM.
- **`npm install` failed compiling `better-sqlite3`** — usually missing
  build tools. Confirm `build-essential` and `python3` installed
  successfully (`apt list --installed | grep build-essential`); re-run
  `sudo ./install.sh` and choose **Repair**.
- **qBittorrent WebUI bootstrap failed** (`bootstrap_qbittorrent` in
  `install.sh`) — qBittorrent's first-run banner format can vary by
  packaged version. Check `journalctl -u qbittorrent-nox -n 100` for a
  "temporary password" line; if the automated login truly can't succeed,
  SSH-tunnel to the WebUI port and set credentials manually, then re-run
  the installer's **Repair** option.

## Management panel won't start

```bash
journalctl -u ihs-torrent-manager -n 100
```

- `Missing required environment variable: ...` — `/etc/ihs-torrent-manager/app.env`
  is incomplete or was hand-edited; compare against `.env.example`.
- Port already in use — another process is bound to `APP_PORT`; change it
  via **Reconfigure** in the installer or edit `app.env` directly and
  `systemctl restart ihs-torrent-manager`.

## Torrents stuck in "queued" / never syncing

This means the worker can't reach qBittorrent.

```bash
journalctl -u ihs-torrent-manager-worker -n 100
curl http://127.0.0.1:8080/api/v2/app/version   # from the server itself
```

- If qBittorrent was restarted and the worker's session expired, it
  reconnects automatically within a few sync cycles — this is expected and
  self-heals (`worker/src/index.ts` forces a fresh login every 3 failed
  attempts).
- If credentials are wrong, compare `TORRENT_USERNAME`/`TORRENT_PASSWORD`
  in `worker.env` against what's actually configured in qBittorrent; re-run
  **Repair** to have the installer re-bootstrap them.

## Upload rejected with "Insufficient free disk space"

Working as intended — the backend refuses new torrents once free space on
the filesystem backing `TORRENT_DOWNLOAD_DIR` drops below the configured
block threshold (default 5% free). Free up space or raise the threshold in
**Settings** (admin).

## Download portal shows nothing

- Confirm at least one torrent has actually reached `status = completed`
  in the management panel — the portal only ever shows completed torrents,
  by design.
- Confirm the portal password was actually set (Settings → Download portal
  password, or `scripts/set-portal-password.js` during install).

## "Invalid or missing CSRF token"

The session likely expired or was cleared. Reload the page (a fresh
`GET /api/auth/me` reissues a token) and log in again if needed.

## Locked out by rate limiting

Login attempts are capped at 10 failures per 15 minutes per username (panel)
or globally (portal, single shared password). Wait 15 minutes, or restart
the relevant service to clear the in-process limiter (the persistent
database-backed counter will still apply for its own window).

## Reverting a bad upgrade

```bash
sudo /opt/ihs-torrent-manager/scripts/restore.sh /var/backups/ihs-torrent-manager/<latest-backup>.tar.gz
```

See [backup.md](backup.md).

## Still stuck

Open an issue on the GitHub repository with the output of
`scripts/healthcheck.sh` and the relevant `journalctl` output (redact any
secrets first).
