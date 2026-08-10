# Administration

## User management

Admin-only, under **Users** in the sidebar:

- **Create user** — username (3-32 chars, letters/numbers/`_.-`), password
  (8+ chars), optional admin flag.
- **Change password** — resets any user's password without needing the old
  one.
- **Promote / demote** — toggles the `is_admin` flag. Demoting the last
  remaining administrator is blocked server-side (`PUT /api/users/:id/admin`
  returns `400`), not just hidden in the UI.
- **Delete user** — blocked for the last remaining administrator and for
  deleting your own account. Deleting a user **never deletes their
  downloaded data**: their torrents are reassigned to the admin performing
  the deletion, so files stay on disk and tracked in the database.

Every one of these rules is enforced in `app/src/routes/users.ts`
server-side — the frontend hiding a button is a UX nicety, not the
security boundary.

## Torrent ownership

Every torrent row has a `user_id`. Every torrent API route
(`GET/POST/DELETE /api/torrents/:id...`) loads the torrent and checks
`torrent.user_id === currentUser.id || currentUser.isAdmin` before doing
anything — a normal user requesting another user's torrent ID gets the
same `404` as a nonexistent ID, so IDs can't be probed to enumerate other
users' torrents.

## Torrent management

**My Torrents** (normal users) / **All Torrents** (admin, adds an Owner
column) support:

- **Pause / Resume / Stop** — Stop is exposed as a distinct action in the
  UI because the spec calls for it, but qBittorrent itself has no separate
  "stop" state from "pause" (its own v5 API renamed pause→stop for the same
  operation) — both map to the same underlying qBittorrent pause call.
- **Delete** — removes the torrent from qBittorrent and the database, but
  keeps downloaded files on disk.
- **Delete + data** (admin only from All Torrents) — also deletes the
  downloaded files. Both delete actions require a confirmation dialog.
- **Recheck** (admin only) — forces qBittorrent to re-verify the torrent's
  data against disk.
- **Details** — click a torrent's name for progress, speed, ETA, category,
  info-hash, per-file list, and a recent-events log.
- **Download** — available once a torrent is `completed`. Clicking it
  mints a short-lived, opaque download link (never the real filename or
  torrent id — see [security.md](security.md#download-privacy)), then
  fetches it; single files stream directly, multi-file torrents are
  zipped on the fly (`archiver`), with every path re-validated against the
  configured download directory before being read.

## Uploading torrents

**Upload Torrent**: drag-and-drop or pick a `.torrent` file. Server-side,
the upload is:

1. Authenticated and size-limited (`MAX_UPLOAD_SIZE_BYTES`, default 10 MB).
2. Parsed with a small defensive bencode decoder (`app/src/utils/torrentValidation.ts`)
   that verifies it's a structurally valid torrent (has `info.name` and
   file-length data) — not just checking the `.torrent` extension.
3. Rejected with `507 Insufficient Storage` if free disk space is already
   below the configured block threshold.
4. Given a sanitized filename (`sanitizeFilename` strips directory
   components and unsafe characters) before being handed to qBittorrent.
5. Recorded in the database with the info-hash computed directly from the
   uploaded file's bytes, so the record exists immediately — the
   background worker fills in live state on its next sync pass.

## Dashboards

- **User dashboard**: active/completed torrent counts, total downloaded,
  current aggregate download speed, and the storage widget.
- **Admin dashboard**: adds total users, active/completed/failed torrents
  across everyone, total storage used by completed torrents, and
  aggregate download/upload activity (`GET /api/admin/stats`).
- **Audit log**: `GET /api/admin/audit-log` records logins (success and
  failure), torrent actions, user management actions, and settings
  changes, each with the acting user, action, target, and IP.

## Download portal

A separate process (`portal/`), separate port, separate session cookie and
secret. It:

- Requires the single configurable portal password (Settings → Download
  portal password, admin only) before showing anything.
- Only ever lists torrents with `status = 'completed'`.
- Resolves file paths purely from the download directory + the torrent's
  display name, using the same path-containment checks as the panel
  (`shared/src/security/paths.ts`, `shared/src/services/torrentFiles.ts`) —
  including re-validating every symlink target stays inside the download
  directory.
- Never receives qBittorrent credentials in its process environment at
  all (see `portal.env` in [configuration.md](configuration.md)) — even a
  full compromise of the portal process can't reach qBittorrent's API.
- Has no other routes: no file browser, no API, no config exposure.
- The "Download" button doesn't link straight to a file: it POSTs to mint
  a short-lived, opaque `/dl/<token>` link (portal-session required, CSRF
  protected), then follows it. See [security.md](security.md#download-privacy)
  for the full design and why the real filename never appears in a URL,
  header, or log.

## Storage / disk space

The dashboard's storage widget calls `df -kP` against the actual
filesystem backing `TORRENT_DOWNLOAD_DIR` (never a client-supplied path),
refreshing every 15 seconds without a full page reload. Warning/critical
thresholds are configurable from Settings and enforced both in the UI
(color-coded) and in the backend (new uploads are rejected once free space
drops below the block threshold, regardless of what the UI shows).

## Bandwidth limits

Settings → **Bandwidth limits** (admin only) sets global upload/download
speed caps, entered in KB/s (0 = unlimited). These are applied directly to
qBittorrent's own rate limiter via its Web API
(`/api/v2/transfer/setDownloadLimit` / `setUploadLimit`) — the application
doesn't implement any throttling itself, and the limits are global (all
torrents combined), not per-torrent or per-user. Changes take effect
immediately, no restart needed.

