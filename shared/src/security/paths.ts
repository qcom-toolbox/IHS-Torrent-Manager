import * as fs from 'fs';
import * as path from 'path';

/**
 * Reduce an untrusted filename to a safe basename: strips directory
 * components, null bytes, control characters, and anything that isn't
 * alphanumeric/./-/_/space. Used for display purposes and for naming
 * temp upload files -- never used to build filesystem paths directly.
 */
export function sanitizeFilename(input: string): string {
  const base = path.basename(input.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/\0/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^a-zA-Z0-9._\- ]/g, '_')
    .trim();
  const truncated = cleaned.slice(0, 255);
  return truncated.length > 0 ? truncated : 'file';
}

/**
 * Resolve `untrustedSegment` against `baseDir`, guaranteeing the final,
 * symlink-resolved path stays inside `baseDir`. Throws if it would escape
 * (via `../`, an absolute path, or a symlink pointing outside baseDir).
 * This is the only sanctioned way to turn user/torrent-supplied path
 * fragments into real filesystem paths in this codebase.
 */
export function safeResolve(baseDir: string, ...untrustedSegments: string[]): string {
  const base = path.resolve(baseDir);
  const baseReal = fs.existsSync(base) ? fs.realpathSync(base) : base;

  const joined = path.resolve(base, ...untrustedSegments.map((s) => s.replace(/\0/g, '')));

  // Compare against the literal (possibly-symlinked) `base`, not its
  // resolved form: `joined` was computed by path.resolve()'ing against
  // `base`, so that's the only consistent thing to compare it to here.
  // Comparing against `baseReal` instead would false-positive whenever
  // `baseDir` itself sits behind a symlink (e.g. a mounted-volume symlink
  // in production, or /tmp on macOS) even for entirely legitimate paths.
  // Symlink *escapes* are still caught below by comparing realpath(joined)
  // against realpath(base).
  if (joined !== base && !joined.startsWith(base + path.sep)) {
    throw new Error('Path escapes base directory');
  }

  // If the target exists, resolve symlinks and re-verify containment so a
  // symlink planted inside baseDir cannot be used to read/write outside it.
  if (fs.existsSync(joined)) {
    const real = fs.realpathSync(joined);
    if (real !== baseReal && !real.startsWith(baseReal + path.sep)) {
      throw new Error('Path escapes base directory (symlink)');
    }
    return real;
  }

  // Target doesn't exist yet (e.g. write destination): verify the deepest
  // existing ancestor doesn't escape via a symlink either.
  let dir = path.dirname(joined);
  while (dir.length >= baseReal.length) {
    if (fs.existsSync(dir)) {
      const realDir = fs.realpathSync(dir);
      if (realDir !== baseReal && !realDir.startsWith(baseReal + path.sep)) {
        throw new Error('Path escapes base directory (symlink ancestor)');
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return joined;
}

export function isSafeCategory(category: string): boolean {
  return /^[a-zA-Z0-9_\- ]{0,64}$/.test(category);
}

/**
 * Content-Disposition filename that reveals as little as possible: a fixed
 * generic base name, plus the original extension only (never the
 * descriptive/semantic part of the name) so the OS/browser can still open
 * the file correctly. Archives always get a flat ".zip" name since the
 * archive format itself is already generic.
 */
export function genericDownloadFilename(realName: string, kind: 'file' | 'archive' = 'file'): string {
  if (kind === 'archive') return 'download.zip';
  const ext = path.extname(realName).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
  return `download${safeExt}`;
}
