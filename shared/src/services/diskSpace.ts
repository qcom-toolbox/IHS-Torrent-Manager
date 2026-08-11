import { execFile } from 'child_process';
import { promisify } from 'util';
import { Settings } from '../db/models';
import { SharedConfig } from '../config';

const execFileAsync = promisify(execFile);

export interface DiskSpaceInfo {
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  freePercent: number;
  level: 'normal' | 'warning' | 'critical';
}

export interface DiskThresholds {
  warningPercentFree: number;
  criticalPercentFree: number;
  blockPercentFree: number;
}

/**
 * Queries the real filesystem that `dir` lives on via `df`. `dir` must be a
 * server-controlled path (the configured torrent download directory) --
 * this function must never be called with a client-supplied path.
 */
export async function getDiskSpace(dir: string, thresholds: DiskThresholds): Promise<DiskSpaceInfo> {
  // -k: 1024-byte blocks, -P: POSIX output format (stable, one line per fs)
  const { stdout } = await execFileAsync('df', ['-kP', dir]);
  const lines = stdout.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  const parts = dataLine.trim().split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const filesystem = parts[0];
  const totalBytes = parseInt(parts[1], 10) * 1024;
  const usedBytes = parseInt(parts[2], 10) * 1024;
  const freeBytes = parseInt(parts[3], 10) * 1024;
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 100;

  let level: DiskSpaceInfo['level'] = 'normal';
  if (freePercent < thresholds.criticalPercentFree) level = 'critical';
  else if (freePercent < thresholds.warningPercentFree) level = 'warning';

  return { filesystem, totalBytes, usedBytes, freeBytes, usedPercent, freePercent, level };
}

interface DirSizeCacheEntry {
  bytes: number | null;
  computedAt: number;
}
// Keyed by directory path -- a single shared cache slot would silently mix
// results across different storage locations once more than one exists.
const dirSizeCache = new Map<string, DirSizeCacheEntry>();
const dirSizeComputing = new Set<string>();

/**
 * Size of a torrent storage directory (`du -sk`). This can be slow on
 * large trees, so results are cached per-directory and refreshed in the
 * background rather than blocking every dashboard request. Returns null
 * until the first `du` run for this directory has completed.
 */
export async function getDirectorySizeCached(dir: string, maxAgeMs = 60_000): Promise<number | null> {
  const entry = dirSizeCache.get(dir);
  const stale = !entry || Date.now() - entry.computedAt > maxAgeMs;
  if (stale && !dirSizeComputing.has(dir)) {
    dirSizeComputing.add(dir);
    execFileAsync('du', ['-sk', dir])
      .then(({ stdout }) => {
        const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
        dirSizeCache.set(dir, { bytes: kb * 1024, computedAt: Date.now() });
      })
      .catch(() => {
        // leave previous cached value in place if du fails
      })
      .finally(() => {
        dirSizeComputing.delete(dir);
      });
  }
  return dirSizeCache.get(dir)?.bytes ?? null;
}

export function canStartNewDownload(freePercent: number, thresholds: DiskThresholds): boolean {
  return freePercent >= thresholds.blockPercentFree;
}

/**
 * Effective thresholds: admin-set values from Settings (changeable at
 * runtime from the UI) if present, otherwise the env-configured defaults.
 * Centralized so every caller (disk widget, upload gate, storage-location
 * admin list) agrees on the same numbers instead of three copies drifting.
 */
export function getConfiguredDiskThresholds(defaults: SharedConfig): DiskThresholds {
  const settings = Settings.all();
  return {
    warningPercentFree: parseInt(settings.disk_warning_percent_free ?? String(defaults.diskWarningPercentFree), 10),
    criticalPercentFree: parseInt(settings.disk_critical_percent_free ?? String(defaults.diskCriticalPercentFree), 10),
    blockPercentFree: parseInt(settings.disk_block_percent_free ?? String(defaults.diskBlockPercentFree), 10),
  };
}
