import { Store, SessionData } from 'express-session';
import { getDb } from './db/connection';

/**
 * Minimal server-side session store backed by the same SQLite database
 * (`sessions` table). Keeps sessions durable across app restarts without
 * requiring a separate session backend like Redis.
 */
export class SqliteSessionStore extends Store {
  constructor(private appName: 'panel' | 'portal', private ttlMs: number) {
    super();
    this.cleanupExpired();
    setInterval(() => this.cleanupExpired(), 60 * 60 * 1000).unref();
  }

  private cleanupExpired(): void {
    try {
      getDb()
        .prepare('DELETE FROM sessions WHERE app = ? AND expires_at < ?')
        .run(this.appName, Date.now());
    } catch {
      // best-effort cleanup
    }
  }

  get(sid: string, callback: (err: any, session?: SessionData | null) => void): void {
    try {
      const row = getDb()
        .prepare('SELECT data, expires_at FROM sessions WHERE sid = ? AND app = ?')
        .get(sid, this.appName) as { data: string; expires_at: number } | undefined;
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, session: SessionData, callback?: (err?: any) => void): void {
    try {
      const expiresAt = session.cookie?.expires
        ? new Date(session.cookie.expires).getTime()
        : Date.now() + this.ttlMs;
      getDb()
        .prepare(
          `INSERT INTO sessions (sid, app, data, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
        )
        .run(sid, this.appName, JSON.stringify(session), expiresAt);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ? AND app = ?').run(sid, this.appName);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid: string, session: SessionData, callback?: () => void): void {
    try {
      const expiresAt = session.cookie?.expires
        ? new Date(session.cookie.expires).getTime()
        : Date.now() + this.ttlMs;
      getDb()
        .prepare('UPDATE sessions SET expires_at = ? WHERE sid = ? AND app = ?')
        .run(expiresAt, sid, this.appName);
      callback?.();
    } catch {
      callback?.();
    }
  }
}
