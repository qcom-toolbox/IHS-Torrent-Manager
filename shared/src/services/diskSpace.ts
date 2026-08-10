import { execFile } from 'child_process';
import { promisify } from 'util';

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

let cachedDirSize: { bytes: number; computedAt: number } | null = null;
let computing = false;

/**
 * Size of the torrent download directory itself (`du -sk`). This can be
 * slow on large trees, so results are cached and refreshed in the
 * background rather than blocking every dashboard request.
 */
export async function getDirectorySizeCached(dir: string, maxAgeMs = 60_000): Promise<number | null> {
  const stale = !cachedDirSize || Date.now() - cachedDirSize.computedAt > maxAgeMs;
  if (stale && !computing) {
    computing = true;
    execFileAsync('du', ['-sk', dir])
      .then(({ stdout }) => {
        const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
        cachedDirSize = { bytes: kb * 1024, computedAt: Date.now() };
      })
      .catch(() => {
        // leave previous cached value in place if du fails
      })
      .finally(() => {
        computing = false;
      });
  }
  return cachedDirSize?.bytes ?? null;
}

export function canStartNewDownload(freePercent: number, thresholds: DiskThresholds): boolean {
  return freePercent >= thresholds.blockPercentFree;
}
