# Security

This is written to be run as an Internet-facing application on a private
server. This document describes what's actually enforced, and where.

## Authentication & sessions

- Passwords are hashed with **Argon2id** (`shared/src/security/password.ts`,
  19 MiB memory cost / 2 iterations, OWASP-recommended minimums). Plaintext
  passwords are never stored or logged.
- Sessions are server-side, stored in the SQLite `sessions` table
  (`shared/src/sessionStore.ts`) — not JWTs, not client-trusted state.
  Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` once
  `COOKIE_SECURE=true` (set this once you're on HTTPS).
- The management panel and download portal use **separate session
  secrets, separate cookies, and separate session rows** (`app` column in
  `sessions`) — compromising one session store doesn't grant access to the
  other application.
- Login is rate-limited two ways: an in-process limiter
  (`express-rate-limit`) and a persistent, database-backed failure counter
  (`login_attempts` table) that survives process restarts — 10 failed
  attempts per identifier within 15 minutes blocks further attempts with
  `429`, for both the panel and the portal.

## Authorization

- Every protected route re-derives the current user from the database on
  every request (`requireAuth` in `app/src/middleware/auth.ts`) rather than
  trusting the session payload — a deleted or demoted user is rejected
  immediately, not just at their next login.
- Torrent ownership (`torrent.user_id === currentUser.id`) is checked
  server-side on every torrent route; admins bypass via `is_admin`, never
  via a client-supplied flag. See [administration.md](administration.md#torrent-ownership).
- Admin-only routes (`/api/users/*`, `/api/admin/*`) are gated by
  `requireAdmin` middleware, independent of anything the frontend renders.
- The last remaining administrator can't be demoted or deleted — enforced
  in the route handler, not just disabled in the UI.

## CSRF

Double-submit-cookie style: a per-session CSRF token is generated
server-side and must be echoed back in an `X-CSRF-Token` header on every
state-changing request (`app/src/middleware/csrf.ts`). A cross-origin page
can't read the token to replay it, since it's never placed in a
JS-readable cookie. The download portal implements the same pattern with a
hidden form field (`portal/src/index.ts`).

## Input validation & file safety

- Uploaded `.torrent` files are parsed with a small, defensive bencode
  decoder (depth/size-limited to resist crafted input) that verifies the
  structure before it's ever handed to qBittorrent
  (`app/src/utils/torrentValidation.ts`).
- **No filesystem path is ever built from client input directly.** Every
  place that turns a torrent name, filename, or qBittorrent-reported path
  into a real path goes through `safeResolve`
  (`shared/src/security/paths.ts`), which:
  - Resolves `..`/absolute-path segments and rejects anything that would
    escape the configured base directory.
  - Re-resolves symlinks (including on the deepest existing ancestor for
    paths that don't exist yet) and rejects the result if the *target*
    escapes the base directory — a malicious symlink planted inside the
    download directory can't be used to read or write outside it.
  - Is used identically by the management panel's download endpoint and
    the (independent) download portal implementation.
- Uploaded filenames are sanitized to a safe basename charset before being
  passed to qBittorrent (`sanitizeFilename`). Downloaded filenames sent
  back to the browser go through a *different*, deliberately generic
  function -- see "Download privacy" below.
- Upload size is capped (`MAX_UPLOAD_SIZE_BYTES`), and only one file per
  request is accepted.

### Storage location containment

Multi-disk support (`shared/src/storageLocations.ts`) extends the
containment model above from a single base directory
(`TORRENT_DOWNLOAD_DIR`) to a small, admin-approved set of them, without
weakening it:

- A torrent's save directory is never taken from client input. Uploads
  reference a storage location by numeric `id` only; the server looks up
  the corresponding path server-side (`resolveStorageRootPath`) and 404s
  if the id doesn't exist or was since deleted (fail closed, not open).
- Registering a new location (`POST /api/admin/storage-locations`,
  admin-only) requires the submitted path to be absolute (relative paths
  are rejected outright rather than silently resolved against the
  server process's working directory) and to already exist as a real,
  writable directory (`checkStorageLocationWritable` does a genuine test
  write + unlink, not just a permission-bit check, since the systemd
  sandbox below can deny writes that Unix permissions would otherwise
  allow).
- Whichever root a torrent's data lives under, `safeResolve` still
  confines every filesystem access to that specific root -- multi-disk
  support changes *which* base directory is used, not whether one is
  enforced.
- At the OS level, every additional disk must also be explicitly added to
  the `ProtectSystem=strict` sandbox's `ReadWritePaths=`/`ReadOnlyPaths=`
  allowlist for each service (`scripts/add-storage-path.sh`, root-only) --
  a path outside that allowlist is denied at the kernel level regardless
  of what the application layer or Unix permissions would otherwise
  allow. See [administration.md](administration.md#multi-disk-storage-locations)
  for the operational flow.

## Download privacy

Every download -- from the management panel or the portal -- goes through
the same two-step, opaque-token design (`shared/src/downloadTokens.ts`):

1. **Mint** (`POST /api/torrents/:id/download-link` on the panel,
   `POST /create-download-link/:id` on the portal): the caller must already
   be authenticated and, on the panel, must own the torrent (or be an
   admin). Only after that check passes is a token generated:
   `crypto.randomBytes(32)` (256 bits), stored **hashed** (`SHA-256`) in a
   new `download_tokens` table -- exactly like a password, the raw token
   exists nowhere at rest, only in the URL handed to the client. It expires
   after `DOWNLOAD_TOKEN_TTL_MINUTES` (default 60).
2. **Redeem** (`GET /api/dl/:token` / `GET /dl/:token`): the URL contains
   *only* the token -- no torrent id, no filename, no extension hint. This
   route is itself still behind the same session-auth middleware as
   everything else, and on the panel it re-checks ownership against the
   token's resolved torrent. **A leaked link alone is not sufficient to
   download the file** -- the redeemer also needs a live session belonging
   to the original owner (or an admin). Every failure mode (unknown token,
   expired token, wrong owner, torrent no longer completed) returns the
   identical generic 404, so a redemption attempt can't be used to
   fingerprint *why* it failed.

What this gets you, mapped to concrete properties:

| Requirement | How it's met |
|---|---|
| No real filename in the URL | URL is `/api/dl/<token>` or `/dl/<token>`, nothing else |
| Opaque/random identifiers | 256-bit `crypto.randomBytes`, base64url-encoded |
| No filename in query params either | there are no query params at all |
| Private storage, not directly reachable | `TORRENT_DOWNLOAD_DIR` is never served statically; see Network exposure |
| Authenticated route verifying permissions | ownership/admin check at mint time *and* session check at redeem time |
| Links are temporary | `expires_at`, checked on every redemption |
| Links are hard to guess | 256 bits of entropy -- brute force is not a practical concern |
| Enumeration protection | tight rate limiting (30/min) on the redemption route, on top of the entropy above |
| Generic `Content-Disposition` | `genericDownloadFilename()` (`shared/src/security/paths.ts`) returns `download<ext>` for a single file or `download.zip` for an archive -- the descriptive/semantic part of the name never reaches a response header |
| Original names not returned unnecessarily | `originalFilename` (the uploaded `.torrent`'s filename) was removed from every JSON API response -- it was never used by the UI to begin with. `display_name` (the torrent's real name) *is* still returned from `GET /api/torrents` etc., because the authenticated dashboard genuinely needs to show it -- hiding it there would break the product, not improve privacy |
| Files reachable only via the platform | there is no other route that serves anything from `TORRENT_DOWNLOAD_DIR`; both redemption handlers resolve paths through `safeResolve`/`resolveContentRoot`, confined to that directory |

Two design choices worth calling out explicitly:

- **Why require a session on redemption at all, instead of a pure bearer
  token (like an S3 presigned URL)?** Because this is a private,
  self-hosted tool where users are expected to stay logged in while
  downloading, and requiring both the token *and* a valid session for the
  right user is strictly stronger: a link that leaks into a chat log, a
  proxy's access log, or shoulder-surfed browser history is useless to
  whoever finds it unless they *also* have a valid session for that
  specific account. The tradeoff is that a token can't be handed to a
  download manager or `wget` without also exporting the session cookie --
  an acceptable cost for a private tool prioritizing confidentiality.
- **Why not single-use tokens?** Large torrents can take a long time to
  download, and browsers/download managers sometimes issue multiple
  `Range` requests for the same URL (parallel-chunk downloading, resuming
  after a pause). A hard single-use limit would break those legitimate
  cases. Time-based expiry plus rate limiting was judged the better
  tradeoff; `download_tokens.use_count` is still tracked for observability.

### What's inside a downloaded archive is out of scope

Multi-file torrents are still zipped with their real internal file/folder
names (`archiver.file(f.absPath, { name: f.relName })`). This is
intentional: those names are the actual content the authorized downloader
requested and needs to make sense of what they received. The privacy
guarantees above are about the transport layer -- URLs, headers, logs,
anything a party *other than* the authorized downloader could observe --
not about hiding a file's contents from the person who legitimately
downloaded it.

### In-browser video playback

The portal can also stream a completed torrent's video files straight into
the browser (a "Watch" button next to the existing per-file "Download"
button on the dashboard) instead of only offering a save-to-disk download.
This reuses the exact same token design as downloads, extended with one
addition:

- `download_tokens.file_index` scopes a token to one specific file inside
  a torrent (vs. `NULL`, meaning "the whole torrent"). `POST
  /create-watch-link/:id/:fileIndex` mints one after checking the file's
  extension against a small allowlist (`isStreamableVideo()` in
  `shared/src/services/torrentFiles.ts`: `.mp4`, `.m4v`, `.mov`, `.webm`,
  `.ogv`, `.mkv`) -- anything else is refused with the same generic 404 as
  every other invalid-token case.
- `GET /watch/:token` renders a player page; `GET /stream/:token` serves
  the actual bytes, Range-request-enabled (via Express's `res.sendFile`)
  so seeking works. Both require the same portal session as every other
  route. `/stream` sits behind its own, more permissive rate limit than
  `/dl` (600/min vs. 30/min) since a single playback session legitimately
  issues many `Range` requests, not because the security bar is lower.
- Decoding happens entirely client-side -- the server only ever streams
  the file's original bytes, never transcodes -- so playback is
  hardware-accelerated by whatever the viewer's browser/OS provides, the
  same as any other native `<video>` element. Multi-audio-track files
  (e.g. multiple dub/commentary tracks muxed into one file) get a track
  selector built on the standard `HTMLMediaElement.audioTracks` API
  (`portal/src/public/watch.js`); this is a progressive enhancement that
  quietly does nothing in browsers that don't support switching it.
- `Content-Disposition: inline` (not `attachment`) and no `filename`, kept
  consistent with the transport-layer privacy goals above; unlike
  downloads there's no generic-filename step needed since no filename is
  sent at all.

### Logs

- Neither the panel nor the portal runs a request-URL access logger
  (no `morgan` or equivalent) -- there is nothing at the application level
  that could echo a download URL into a log file. Operational history
  instead goes through `audit_log` (`torrent_download`,
  `torrent_download_link_created`, `portal_download`,
  `portal_download_link_created`), which records the acting user (or
  `NULL` for the portal, which has no per-user identity) and the torrent's
  numeric ID -- never a filename.
- If you put this behind Nginx/Caddy, their default access-log format logs
  the full request path. Since that path is now always an opaque token (or
  a login/API path with no filename in it), there is nothing left for a
  reverse-proxy log to leak -- this was true by construction once the URL
  redesign above landed, not something that needed separate log
  configuration.
- Error responses on the download path never include `err.message` --
  redemption failures return a single fixed string regardless of cause.

## SQL injection

All database access goes through `better-sqlite3` prepared statements with
bound parameters (`shared/src/db/models.ts`) — no string-concatenated SQL
anywhere in the codebase.

## XSS

React escapes all rendered content by default; the codebase does not use
`dangerouslySetInnerHTML`. The download portal's EJS templates use `<%=`
(auto-escaping) throughout. A strict `Content-Security-Policy` is set via
`helmet` on both the panel and the portal (`default-src 'self'`, no inline
scripts, no framing).

## Secrets & configuration

- `SESSION_SECRET`, `PORTAL_SESSION_SECRET`, and the qBittorrent WebUI
  password are randomly generated by the installer
  (`node -e "crypto.randomBytes(48)..."` / `openssl rand`), never
  hardcoded in source.
- Environment files live under `/etc/ihs-torrent-manager/`, mode `640`, owned
  by `root:ihs-torrent-manager` — readable only by root and the service
  account, not world-readable.
- **The download portal process never receives qBittorrent credentials at
  all** — `portal.env` simply doesn't contain `TORRENT_HOST` /
  `TORRENT_USERNAME` / `TORRENT_PASSWORD`, and the portal's code never
  imports the qBittorrent client. This is enforced at the config-loading
  level (`loadQbtConfig()` is a separate function from `loadSharedConfig()`
  in `shared/src/config.ts`), not just by convention.
- `.env`, real config files, and any secrets are excluded via `.gitignore`
  and were never committed; `.env.example` documents variable names only.

## Transport security (HTTPS)

- Both the panel and the portal send `Strict-Transport-Security` (via
  `helmet`'s `hsts` option, `max-age=180 days`, `includeSubDomains`)
  unconditionally. The header is harmless over plain HTTP -- browsers only
  act on it once they've received it over a real HTTPS connection -- so
  sending it always means HTTPS gets enforced from the very first secure
  visit, with no extra configuration step.
- `COOKIE_SECURE=true` (set this once you're behind HTTPS, see
  [configuration.md](configuration.md)) marks session cookies `Secure`, so
  they're never sent over a plaintext connection even if one is somehow
  reachable. It also gates three CSP/Helmet behaviors that only make sense
  once TLS is actually in front: `upgrade-insecure-requests`,
  `Cross-Origin-Opener-Policy`, and `Origin-Agent-Cluster`. Confirmed
  against a real browser during deployment: leaving
  `upgrade-insecure-requests` on while serving plain HTTP makes the
  browser silently rewrite every asset/API/form request to `https://`;
  with no TLS listener on that port, every one of those requests fails
  with `ERR_SSL_PROTOCOL_ERROR` -- a blank management panel, an unstyled
  portal login, blocked form submissions -- while `curl` against the same
  server sees nothing wrong at all, since CSP is purely a browser-enforced
  mechanism. This is why `COOKIE_SECURE` defaults to `false` and must be
  turned on deliberately once (and only once) a reverse proxy with a real
  certificate is actually in front.
- The installer's optional nginx/Caddy integration exists specifically to
  get you onto HTTPS with a real certificate (Caddy does this
  automatically; nginx needs a separate `certbot --nginx` run, called out
  in the installer's output). Running this application without a reverse
  proxy in front of it, directly over plain HTTP on the open Internet, is
  not a supported configuration -- the opaque-token download design above
  raises the bar for a passive network observer, but it does not replace
  transport encryption for session cookies and credentials.

## Network exposure

- qBittorrent's WebUI is bound to `127.0.0.1` (`WebUI\Address` in
  `qBittorrent.conf`, written by the installer) and its port is never
  opened in the firewall — only the app and worker, both on the same host,
  can reach it.
- The database is a local SQLite file, not a network service — there is no
  database port to expose in the first place.
- Only the management panel port and the download portal port are
  candidates for firewall/reverse-proxy exposure; the installer only opens
  those two in UFW, and only with explicit confirmation.

## Process isolation

- All four services run as a dedicated, unprivileged system user
  (`ihs-torrent-manager`, no login shell) — never as root.
- Each systemd unit sets `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, and an explicit `ReadWritePaths`/
  `ReadOnlyPaths` allowlist. The download portal's unit in particular gets
  `ReadOnlyPaths` for the torrent directory — it has no legitimate reason
  to write there. See `systemd/*.service`.

## Automated tests

`app/test/download-privacy.test.js` and `portal/test/download-privacy.test.js`
(run with `npm test`, Node's built-in test runner, no extra dependencies)
boot a real instance of each app on an ephemeral port against a throwaway
database and real files on disk with deliberately sensitive names, then
drive it over real HTTP. They assert, among other things:

- an unauthenticated request can't mint a link, can't redeem one, and gets
  redirected/rejected before ever seeing torrent data;
- a non-owner (panel) can't mint a link for someone else's torrent;
- a valid, unexpired token is still refused if presented without the
  right session (a leaked link alone isn't enough);
- minted URLs match `/api/dl/<token>` or `/dl/<token>` exactly, with
  nothing else in the path;
- `Content-Disposition` never contains the real name, only `download<ext>`
  or `download.zip`;
- guessed and expired tokens both get the same generic 404;
- `GET /api/torrents` never includes the unused `originalFilename` field;
- repeated redemption attempts eventually hit the rate limiter.

The panel's suite stubs qBittorrent with a minimal real HTTP server
implementing just the two endpoints the app calls (login, torrent file
listing) -- everything on this codebase's side of that boundary runs
unmocked, including the actual `download_tokens` table, the actual
`safeResolve`/`resolveContentRoot` path logic, and the actual Express
routing/middleware stack.

## Known limitations

- Rate limiting is in-process (per systemd service instance); this
  application is designed to run as a single instance per host, which
  matches its self-hosted, single-server deployment model.
- The bencode-based `.torrent` validator confirms structural validity, not
  the semantic safety of what a torrent will eventually download —
  qBittorrent itself is responsible for the actual download, exactly as it
  would be if used directly.
- `npm audit` reports a moderate advisory in `esbuild`/`vite` (a
  `frontend` **devDependency** only, `GHSA-67mh-4wv8-2f99`). It affects
  `vite`'s local dev server (`npm run dev`), not the production build:
  `install.sh` never runs a Vite dev server, it runs `vite build` once and
  serves the resulting static files from Express. Fixing it requires a
  Vite 8 major upgrade not yet validated against this project's build
  config; tracked as a follow-up rather than shipped as an untested jump.
