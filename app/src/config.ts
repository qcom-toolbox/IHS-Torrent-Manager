import * as path from 'path';
import { loadSharedConfig, loadQbtConfig } from '@torrent-manager/shared';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
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

export const shared = loadSharedConfig();
export const qbtConfig = loadQbtConfig();

export const appConfig = {
  port: intEnv('APP_PORT', 3000),
  host: optionalEnv('APP_HOST', '127.0.0.1'),
  sessionSecret: requireEnv('SESSION_SECRET'),
  cookieSecure: boolEnv('COOKIE_SECURE', false),
  trustProxy: boolEnv('TRUST_PROXY', false),
  maxUploadBytes: intEnv('MAX_UPLOAD_SIZE_BYTES', 10 * 1024 * 1024),
  frontendDistDir: path.resolve(optionalEnv('FRONTEND_DIST_DIR', path.join(__dirname, '../../frontend/dist'))),
  uploadTmpDir: path.resolve(optionalEnv('UPLOAD_TMP_DIR', path.join(shared.databasePath, '..', 'tmp-uploads'))),
};
