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

### Quick fix after `git pull`

If a previous install attempt hit a problem that's since been fixed
upstream (e.g. a bad systemd hardening directive, a unit-file ordering
bug), you don't need to re-run the full interactive installer:

```bash
cd IHS-Torrent-Manager
git pull
sudo ./fix-install.sh
```

This re-deploys the current code, re-renders and reinstalls the systemd
unit files, re-verifies qBittorrent's WebUI credentials, and restarts
every service — fully non-interactive, and it never touches the admin
account, the portal password, or torrent data. It's equivalent to
`sudo ./install.sh` → **Repair**, just without the menu.

### "qBittorrent bootstrap failed" / "qBittorrent WebUI not responding" even though it's actually up

If `systemctl status qbittorrent-nox` shows it `active (running)` with no
errors, and `curl -v http://127.0.0.1:8080/api/v2/app/version` returns a
clean `403 Forbidden` (not "connection refused"), qBittorrent is healthy
-- this was a bug in the installer's readiness check, not a real problem.
`qbt-bootstrap.js` deliberately configures qBittorrent to require
authentication even from `127.0.0.1` (`bypass_local_auth: false` --
localhost isn't blindly trusted), so an unauthenticated probe correctly
gets a 403. Older versions of `install.sh`/`scripts/healthcheck.sh` used
`curl -f`, which treats *any* non-2xx response as "down", including this
expected 403. Fixed to accept any HTTP response (403 included) as proof
the WebUI is reachable. `git pull && sudo ./fix-install.sh` picks up the
fix.

### Node/V8 crash-looping right after install (`Check failed: 12 == ...`)

If `systemctl status ihs-torrent-manager` (or `-worker`/`-portal`) shows
`code=killed, signal=TRAP` and the journal shows a V8 `Fatal error` /
`Check failed: 12 == (*__errno_location())` inside
`CodeRange::RemapEmbeddedBuiltins`, that's Node's V8 JIT being blocked by
the `MemoryDenyWriteExecute=true` systemd hardening directive (V8 needs to
`mprotect()` memory as writable+executable at startup; that directive's
seccomp filter denies it, and V8 crashes immediately instead of falling
back). This was present in unit files generated before this fix landed.
Run `sudo ./fix-install.sh` after `git pull` to pick up the corrected
unit files (the directive has been removed from all three Node services;
qBittorrent itself, being a native binary with no JIT, was never affected).

### "qBittorrent request failed: ... POST /api/v2/torrents/pause -> HTTP 404"

qBittorrent 5.0 renamed its WebAPI endpoints `torrents/pause` →
`torrents/stop` and `torrents/resume` → `torrents/start` (same request
shape, new path). If your `apt install qbittorrent-nox` pulled in a 5.x
build, every pause-based action -- the Pause/Stop buttons, and the
Settings → Downloading/Uploading master switches -- would fail with
exactly this 404 against versions of the app built before this fix.
Fixed: `QbittorrentClient.pause()`/`resume()` now try the old endpoint
first and automatically fall back to the new one on a 404, caching
whichever one actually works so it's only ever one extra request, on
first use. No configuration needed -- `git pull && sudo ./upgrade.sh`
picks up the fix; nothing needs to be reconfigured for your specific
qBittorrent version.

### Blank management panel / unstyled portal login when accessed over plain HTTP

If `curl` against the panel/portal returns everything correctly (`200`,
right `Content-Type`, right bytes) but your **browser** shows a blank
page (panel) or a login page with no CSS (portal), open DevTools →
Console. If you see `net::ERR_SSL_PROTOCOL_ERROR` on requests to
`https://<host>:3000/assets/...` even though you typed `http://` in the
address bar, this is `COOKIE_SECURE=true` being set while there's no
actual TLS listener on that port. With it on, the CSP sent to the browser
includes `upgrade-insecure-requests`, which makes the browser silently
rewrite every asset/API/form request to `https://` -- and those all fail
outright with nothing listening for TLS. Fix: leave `COOKIE_SECURE=false`
in `app.env`/`portal.env` until you've actually put a reverse proxy with
a real certificate in front (see [configuration.md](configuration.md)
and [security.md](security.md#transport-security-https)), then restart
the affected service(s).

If instead you're accessing the panel/portal from another device on your
network and get `ERR_CONNECTION_REFUSED` (not even a blank page -- the
connection itself fails), that's a *different* issue: `APP_HOST`/
`PORTAL_HOST` default to `127.0.0.1` (loopback only, deliberately). Either
tunnel in (`ssh -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 user@host`)
or, for trusted-LAN access, set `APP_HOST=0.0.0.0` /
`PORTAL_HOST=0.0.0.0` in the respective env file and restart:

```bash
sudo sed -i 's/^APP_HOST=.*/APP_HOST=0.0.0.0/' /etc/ihs-torrent-manager/app.env
sudo sed -i 's/^PORTAL_HOST=.*/PORTAL_HOST=0.0.0.0/' /etc/ihs-torrent-manager/portal.env
sudo systemctl restart ihs-torrent-manager ihs-torrent-manager-portal
```

Never do this for `TORRENT_HOST`/qBittorrent's own bind address -- that
one must stay on `127.0.0.1`. This customization (and `COOKIE_SECURE`/
`TRUST_PROXY`, if you've set those too) is preserved across
`sudo ./upgrade.sh` / `sudo ./fix-install.sh` / `sudo ./install.sh`
(Reconfigure) runs -- they only fall back to the `127.0.0.1`/`false`
defaults if the setting was never customized in the first place.

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

## Adding a storage location fails with a "not writable" / remediation message

This means the path exists and has the right Unix ownership, but the
systemd sandbox (`ProtectSystem=strict`) doesn't have it in its
`ReadWritePaths=` allowlist yet — a real test write to the directory was
attempted and denied at the kernel level. The error message itself
contains the exact command to run; it looks like:

```bash
sudo scripts/add-storage-path.sh /mnt/disk2/torrents "Disk 2"
```

Run that once, as root, on the server. It creates the directory if
missing, grants `qbittorrent-nox`, the management panel, and the worker
write access (and the portal read-only access), restarts the four
services, and registers the location — no need to also add it from the
Settings UI afterward, it appears automatically. See
[administration.md](administration.md#multi-disk-storage-locations) for
the full flow.

If a location was working and suddenly stops (uploads to it fail again
after an `upgrade.sh`/`fix-install.sh` run), that's a bug — the installer
is supposed to re-grant every previously-registered location's sandbox
access automatically every time it rewrites the systemd unit files.
Check `journalctl -u ihs-torrent-manager -n 50` for the actual denial and
open an issue.

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
