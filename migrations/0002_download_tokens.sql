-- Opaque, short-lived download tokens. The download URL a browser ever sees
-- is /api/dl/<raw token> (panel) or /dl/<raw token> (portal) -- never the
-- torrent id, never the filename. Only the SHA-256 hash of the token is
-- stored, so a database read alone can't be used to redeem downloads
-- (same principle as password hashing / password-reset tokens).

CREATE TABLE IF NOT EXISTS download_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    torrent_id   INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    issued_by    TEXT NOT NULL,   -- 'panel' | 'portal'
    user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at   TEXT NOT NULL,
    last_used_at TEXT,
    use_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_download_tokens_torrent_id ON download_tokens(torrent_id);
CREATE INDEX IF NOT EXISTS idx_download_tokens_expires_at ON download_tokens(expires_at);
