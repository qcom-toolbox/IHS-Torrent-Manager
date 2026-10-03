-- User-chosen label for a torrent, so it's easy to find in the UI.
-- Kept separate from display_name on purpose: display_name mirrors the
-- name qBittorrent uses on disk (the worker refreshes it every sync and
-- the portal uses it to locate the downloaded files), so it must never
-- be edited by a user. NULL means "no custom name, show display_name".
ALTER TABLE torrents ADD COLUMN custom_name TEXT;
