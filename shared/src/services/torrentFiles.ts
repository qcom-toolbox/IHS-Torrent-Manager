import * as fs from 'fs';
import * as path from 'path';
import { safeResolve } from '../security/paths';

// Extensions the portal will offer an in-browser "Watch" button for, and
// their MIME types for the Content-Type header. Deliberately conservative:
// only containers/codecs modern browsers can decode natively (so playback
// is entirely client-side, GPU-accelerated by the browser/OS -- this app
// never transcodes). Anything not on this list only ever gets a Download
// button, never streamed inline.
const VIDEO_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
};

/** True if `relName`'s extension is one the portal will stream inline for in-browser playback. */
export function isStreamableVideo(relName: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_MIME_TYPES, path.extname(relName).toLowerCase());
}

/** MIME type to serve a streamable video file as, or null if it isn't one. */
export function videoMimeType(relName: string): string | null {
  return VIDEO_MIME_TYPES[path.extname(relName).toLowerCase()] ?? null;
}

export interface ResolvedTorrentFile {
  /** Verified-safe absolute path on disk. */
  absPath: string;
  /** Relative path/name to present to the downloader (used inside zip archives). */
  relName: string;
  size: number;
}

/**
 * Turns qBittorrent-reported file entries (which include a save path and
 * per-file relative names, both ultimately derived from attacker-controlled
 * torrent metadata) into verified-safe absolute paths confined to
 * `downloadDir`. Throws if anything would resolve outside of it.
 */
export function resolveTorrentContentPaths(
  downloadDir: string,
  qbtSavePath: string,
  files: { name: string; size: number }[]
): ResolvedTorrentFile[] {
  const relativeSaveDir = path.isAbsolute(qbtSavePath)
    ? path.relative(downloadDir, qbtSavePath)
    : qbtSavePath;

  return files.map((f) => {
    // qBittorrent uses forward slashes for nested paths regardless of OS.
    const parts = f.name.split('/').filter((p) => p.length > 0 && p !== '.' && p !== '..');
    const absPath = safeResolve(downloadDir, relativeSaveDir, ...parts);
    return { absPath, relName: parts.join('/'), size: f.size };
  });
}

/**
 * Resolves a completed torrent's on-disk content root purely from the
 * download directory + torrent display name (both server-controlled after
 * validation), without needing any qBittorrent API access. This is what
 * the download portal uses -- it deliberately never talks to qBittorrent
 * or holds its credentials.
 */
export function resolveContentRoot(downloadDir: string, displayName: string): string {
  return safeResolve(downloadDir, displayName);
}

/**
 * Recursively lists files under `rootAbsPath` (itself already verified
 * inside downloadDir), re-checking every entry -- including symlink
 * targets -- stays within `downloadDir`. Entries that would escape are
 * silently skipped rather than followed.
 */
export function listFilesRecursively(downloadDir: string, rootAbsPath: string): ResolvedTorrentFile[] {
  const downloadDirReal = fs.existsSync(downloadDir) ? fs.realpathSync(downloadDir) : path.resolve(downloadDir);
  const results: ResolvedTorrentFile[] = [];

  const stat = fs.statSync(rootAbsPath);
  if (stat.isFile()) {
    return [{ absPath: rootAbsPath, relName: path.basename(rootAbsPath), size: stat.size }];
  }
  if (!stat.isDirectory()) return [];

  function walk(dir: string, relPrefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      let real: string;
      try {
        real = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (real !== downloadDirReal && !real.startsWith(downloadDirReal + path.sep)) {
        continue; // symlink escapes the download directory -- skip it
      }
      const relName = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, relName);
      } else if (entry.isFile()) {
        const size = fs.statSync(real).size;
        results.push({ absPath: real, relName, size });
      }
    }
  }

  walk(rootAbsPath, path.basename(rootAbsPath));
  return results;
}
