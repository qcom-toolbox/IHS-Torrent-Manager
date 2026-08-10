-- Initial schema for IHS Torrent Manager

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS torrents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    torrent_hash      TEXT NOT NULL UNIQUE,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    original_filename TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'queued',
    progress          REAL NOT NULL DEFAULT 0,
    download_speed    INTEGER NOT NULL DEFAULT 0,
    upload_speed      INTEGER NOT NULL DEFAULT 0,
    size              INTEGER NOT NULL DEFAULT 0,
    eta_seconds       INTEGER,
    save_path         TEXT,
    category          TEXT,
    is_dir            INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at      TEXT,
    last_synced_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_torrents_user_id ON torrents(user_id);
CREATE INDEX IF NOT EXISTS idx_torrents_status ON torrents(status);
CREATE INDEX IF NOT EXISTS idx_torrents_hash ON torrents(torrent_hash);

CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    app        TEXT NOT NULL DEFAULT 'panel',
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS torrent_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    torrent_id INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message    TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_torrent_events_torrent_id ON torrent_events(torrent_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    details     TEXT,
    ip_address  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    app        TEXT NOT NULL DEFAULT 'panel',
    success    INTEGER NOT NULL,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier, created_at);
