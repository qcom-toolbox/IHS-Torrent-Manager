-- Additional storage locations (extra disks/mount points) an admin can
-- register beyond the default TORRENT_DOWNLOAD_DIR. Every path here is
-- admin-approved and stored server-side -- uploads reference a location by
-- ID, never by a client-supplied path, and every file operation still goes
-- through safeResolve()/resolveContentRoot() confined to whichever
-- location's `path` the torrent belongs to (see shared/src/storageLocations.ts).

CREATE TABLE IF NOT EXISTS storage_locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- NULL means "the default TORRENT_DOWNLOAD_DIR" (the original, always-
-- present location configured via the env var) -- existing torrents don't
-- need backfilling.
ALTER TABLE torrents ADD COLUMN storage_location_id INTEGER REFERENCES storage_locations(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_torrents_storage_location_id ON torrents(storage_location_id);
