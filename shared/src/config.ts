import * as path from 'path';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export interface SharedConfig {
  nodeEnv: string;
  databasePath: string;
  torrentDownloadDir: string;
  diskWarningPercentFree: number;
  diskCriticalPercentFree: number;
  diskBlockPercentFree: number;
  /** Optional path to a plain-text access-notice banner shown on both login pages. Unset/missing = no banner. */
  noticeFilePath: string | undefined;
}

let cached: SharedConfig | null = null;

/**
 * Config common to all three services (app, worker, portal). Deliberately
 * excludes qBittorrent connection details -- the download portal must never
 * hold qBittorrent credentials in its process environment, so those live in
 * `loadQbtConfig()` instead, which only the app and worker call.
 */
export function loadSharedConfig(): SharedConfig {
  if (cached) return cached;
  cached = {
    nodeEnv: optionalEnv('NODE_ENV', 'production'),
    databasePath: path.resolve(requireEnv('DATABASE_PATH')),
    torrentDownloadDir: path.resolve(requireEnv('TORRENT_DOWNLOAD_DIR')),
    diskWarningPercentFree: intEnv('DISK_WARNING_THRESHOLD_PERCENT_FREE', 20),
    diskCriticalPercentFree: intEnv('DISK_CRITICAL_THRESHOLD_PERCENT_FREE', 10),
    diskBlockPercentFree: intEnv('DISK_BLOCK_THRESHOLD_PERCENT_FREE', 5),
    noticeFilePath: process.env.NOTICE_FILE_PATH ? path.resolve(process.env.NOTICE_FILE_PATH) : undefined,
  };
  return cached;
}

export interface QbtConfig {
  torrentHost: string;
  torrentUsername: string;
  torrentPassword: string;
  workerSyncIntervalMs: number;
}

let cachedQbt: QbtConfig | null = null;

export function loadQbtConfig(): QbtConfig {
  if (cachedQbt) return cachedQbt;
  cachedQbt = {
    torrentHost: requireEnv('TORRENT_HOST'),
    torrentUsername: requireEnv('TORRENT_USERNAME'),
    torrentPassword: requireEnv('TORRENT_PASSWORD'),
    workerSyncIntervalMs: intEnv('WORKER_SYNC_INTERVAL_MS', 5000),
  };
  return cachedQbt;
}

export { requireEnv, optionalEnv, intEnv, boolEnv };
