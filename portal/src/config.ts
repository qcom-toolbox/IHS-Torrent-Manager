import { loadSharedConfig } from '@ihs-torrent-manager/shared';

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

export const portalConfig = {
  port: intEnv('PORTAL_PORT', 3001),
  host: optionalEnv('PORTAL_HOST', '127.0.0.1'),
  sessionSecret: requireEnv('PORTAL_SESSION_SECRET'),
  cookieSecure: boolEnv('COOKIE_SECURE', false),
  trustProxy: boolEnv('TRUST_PROXY', false),
};
