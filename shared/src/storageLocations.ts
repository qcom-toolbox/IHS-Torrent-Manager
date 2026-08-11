import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './db/connection';

export interface StorageLocation {
  id: number;
  label: string;
  path: string;
  created_at: string;
}

export const StorageLocations = {
  all(): StorageLocation[] {
    return getDb().prepare('SELECT * FROM storage_locations ORDER BY id ASC').all() as StorageLocation[];
  },
  findById(id: number): StorageLocation | undefined {
    return getDb().prepare('SELECT * FROM storage_locations WHERE id = ?').get(id) as StorageLocation | undefined;
  },
  findByPath(absolutePath: string): StorageLocation | undefined {
    return getDb()
      .prepare('SELECT * FROM storage_locations WHERE path = ?')
      .get(absolutePath) as StorageLocation | undefined;
  },
  create(label: string, absolutePath: string): StorageLocation {
    const info = getDb()
      .prepare('INSERT INTO storage_locations (label, path) VALUES (?, ?)')
      .run(label, absolutePath);
    return StorageLocations.findById(info.lastInsertRowid as number)!;
  },
  countTorrentsUsing(id: number): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) as c FROM torrents WHERE storage_location_id = ?')
      .get(id) as { c: number };
    return row.c;
  },
  delete(id: number): void {
    getDb().prepare('DELETE FROM storage_locations WHERE id = ?').run(id);
  },
};

export interface StorageWriteCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies a path is absolute, exists as a directory, and is actually
 * writable by *this process, right now* -- a real test write, not just a
 * POSIX permission-bit check. This is what catches systemd's sandboxing
 * (ReadWritePaths=) denying access to a disk that isn't in the unit
 * file's allowlist yet, which a plain fs.accessSync() would miss (the
 * directory can be perfectly writable by the Unix permission model and
 * still be denied by the seccomp/namespace sandbox).
 */
export function checkStorageLocationWritable(absolutePath: string): StorageWriteCheckResult {
  if (!path.isAbsolute(absolutePath)) {
    return { ok: false, reason: 'Path must be absolute' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { ok: false, reason: 'Path does not exist on this server' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'Path is not a directory' };
  }
  const probeFile = path.join(absolutePath, `.ihs-tm-write-test-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
  } catch (err: any) {
    return {
      ok: false,
      reason:
        `Not writable by the application (${err.code || err.message}). If this path is on a disk not yet ` +
        `covered by the service's systemd sandbox, run on the server: ` +
        `sudo scripts/add-storage-path.sh "${absolutePath}" -- it grants write access and restarts the services.`,
    };
  }
  return { ok: true };
}

/**
 * Resolves the actual on-disk root a torrent's files live under: its own
 * storage location if it has one, else the default TORRENT_DOWNLOAD_DIR.
 * Throws (rather than silently falling back) if the torrent references a
 * location that's since been deleted -- fail closed, don't guess.
 */
export function resolveStorageRootPath(defaultDownloadDir: string, storageLocationId: number | null): string {
  if (storageLocationId == null) return defaultDownloadDir;
  const loc = StorageLocations.findById(storageLocationId);
  if (!loc) {
    throw new Error(`Storage location ${storageLocationId} no longer exists`);
  }
  return loc.path;
}
