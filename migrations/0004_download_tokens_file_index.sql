-- Lets a download token point at one specific file within a (possibly
-- multi-file) completed torrent, instead of always meaning "the whole
-- thing". Used by the portal's in-browser video viewer: the token minted
-- for a "Watch" click is scoped to that one file, the same way a
-- "Download" token is scoped to the torrent. NULL preserves the existing
-- meaning ("all files / whichever loadCompletedTorrentFiles() resolves").
ALTER TABLE download_tokens ADD COLUMN file_index INTEGER;
