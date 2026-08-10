# Backup & Restore

## What gets backed up

`scripts/backup.sh` backs up:

- The SQLite database (via SQLite's own online `.backup` command, safe to
  run while services are active — it doesn't require stopping anything).
- `/etc/ihs-torrent-manager/` — environment files, generated secrets, and the
  install-state file.

It deliberately does **not** include the torrent download directory —
that's expected to be large (potentially far larger than reasonable for a
routine config/database backup) and typically lives on its own volume.
Back it up separately with whatever tool suits your storage (filesystem
snapshot, `rsync`, etc.) if you need that too.

## Taking a backup

```bash
sudo /opt/ihs-torrent-manager/scripts/backup.sh [output-directory]
# defaults to /var/backups/ihs-torrent-manager
```

Produces `ihs-torrent-manager-backup-<UTC timestamp>.tar.gz`, mode `600`.

### Automating it

```bash
sudo crontab -e
# nightly at 03:00
0 3 * * * /opt/ihs-torrent-manager/scripts/backup.sh /var/backups/ihs-torrent-manager
```

## Restoring

```bash
sudo /opt/ihs-torrent-manager/scripts/restore.sh /var/backups/ihs-torrent-manager/ihs-torrent-manager-backup-20260101-030000.tar.gz
```

This stops the three IHS Torrent Manager services, replaces the database and
`/etc/ihs-torrent-manager/` contents with the backup's, fixes ownership, and
restarts. It asks for confirmation before touching anything. qBittorrent's
own state (in `/var/lib/ihs-torrent-manager/qbittorrent`) and torrent data are
not part of this backup/restore flow — if you need those restored too,
restore them from your own filesystem backup before running this script,
since credentials in the restored `app.env`/`worker.env` need to match
whatever qBittorrent WebUI account actually exists.

## Disaster recovery order

1. Reinstall the OS / provision a new host if starting from scratch.
2. `git clone` the repository and run `sudo ./install.sh` to get a working
   baseline (this creates a *new* admin account and qBittorrent
   credentials — that's fine, they'll be overwritten next).
3. Restore torrent data to the download directory from your own filesystem
   backup, if applicable.
4. Run `scripts/restore.sh` with your latest backup archive to bring back
   the real database, users, and secrets.
5. `sudo systemctl restart ihs-torrent-manager ihs-torrent-manager-worker ihs-torrent-manager-portal qbittorrent-nox`
   and check `scripts/healthcheck.sh`.
