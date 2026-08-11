import { getDb } from './connection';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
}

export type TorrentStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'missing'
  | 'stopped';

export interface Torrent {
  id: number;
  torrent_hash: string;
  user_id: number;
  original_filename: string;
  display_name: string;
  status: TorrentStatus;
  progress: number;
  download_speed: number;
  upload_speed: number;
  size: number;
  eta_seconds: number | null;
  save_path: string | null;
  category: string | null;
  is_dir: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  last_synced_at: string | null;
  /** NULL means the default TORRENT_DOWNLOAD_DIR; otherwise a storage_locations.id. */
  storage_location_id: number | null;
}

export interface AuditLogEntry {
  id: number;
  user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

// ---------- Users ----------

export const Users = {
  findById(id: number): User | undefined {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  },
  findByUsername(username: string): User | undefined {
    return getDb()
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as User | undefined;
  },
  all(): User[] {
    return getDb().prepare('SELECT * FROM users ORDER BY id ASC').all() as User[];
  },
  count(): number {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    return row.c;
  },
  countAdmins(): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) as c FROM users WHERE is_admin = 1')
      .get() as { c: number };
    return row.c;
  },
  create(username: string, passwordHash: string, isAdmin: boolean): User {
    const info = getDb()
      .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
      .run(username, passwordHash, isAdmin ? 1 : 0);
    return Users.findById(info.lastInsertRowid as number)!;
  },
  updatePassword(id: number, passwordHash: string): void {
    getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  },
  setAdmin(id: number, isAdmin: boolean): void {
    getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  },
  reassignTorrents(fromUserId: number, toUserId: number): void {
    getDb()
      .prepare('UPDATE torrents SET user_id = ? WHERE user_id = ?')
      .run(toUserId, fromUserId);
  },
  delete(id: number): void {
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

// ---------- Torrents ----------

export const Torrents = {
  findById(id: number): Torrent | undefined {
    return getDb().prepare('SELECT * FROM torrents WHERE id = ?').get(id) as Torrent | undefined;
  },
  findByHash(hash: string): Torrent | undefined {
    return getDb()
      .prepare('SELECT * FROM torrents WHERE torrent_hash = ?')
      .get(hash) as Torrent | undefined;
  },
  allForUser(userId: number): Torrent[] {
    return getDb()
      .prepare('SELECT * FROM torrents WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Torrent[];
  },
  all(): Torrent[] {
    return getDb().prepare('SELECT * FROM torrents ORDER BY created_at DESC').all() as Torrent[];
  },
  allCompleted(): Torrent[] {
    return getDb()
      .prepare("SELECT * FROM torrents WHERE status = 'completed' ORDER BY completed_at DESC")
      .all() as Torrent[];
  },
  create(data: {
    torrent_hash: string;
    user_id: number;
    original_filename: string;
    display_name: string;
    category: string;
    storage_location_id?: number | null;
  }): Torrent {
    const info = getDb()
      .prepare(
        `INSERT INTO torrents (torrent_hash, user_id, original_filename, display_name, category, status, storage_location_id)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run(
        data.torrent_hash,
        data.user_id,
        data.original_filename,
        data.display_name,
        data.category,
        data.storage_location_id ?? null
      );
    return Torrents.findById(info.lastInsertRowid as number)!;
  },
  updateSyncState(
    hash: string,
    fields: Partial<
      Pick<
        Torrent,
        | 'status'
        | 'progress'
        | 'download_speed'
        | 'upload_speed'
        | 'size'
        | 'eta_seconds'
        | 'save_path'
        | 'is_dir'
        | 'error_message'
        | 'completed_at'
        | 'display_name'
      >
    >
  ): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (fields as any)[k]);
    getDb()
      .prepare(
        `UPDATE torrents SET ${setClause}, last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE torrent_hash = ?`
      )
      .run(...values, hash);
  },
  markMissing(hashesPresent: string[]): void {
    const db = getDb();
    if (hashesPresent.length === 0) {
      db.prepare(
        "UPDATE torrents SET status = 'missing' WHERE status NOT IN ('missing')"
      ).run();
      return;
    }
    const placeholders = hashesPresent.map(() => '?').join(',');
    db.prepare(
      `UPDATE torrents SET status = 'missing' WHERE torrent_hash NOT IN (${placeholders}) AND status != 'missing'`
    ).run(...hashesPresent);
  },
  delete(id: number): void {
    getDb().prepare('DELETE FROM torrents WHERE id = ?').run(id);
  },
};

// ---------- Torrent events ----------

export const TorrentEvents = {
  add(torrentId: number, eventType: string, message?: string): void {
    getDb()
      .prepare('INSERT INTO torrent_events (torrent_id, event_type, message) VALUES (?, ?, ?)')
      .run(torrentId, eventType, message ?? null);
  },
  forTorrent(torrentId: number): any[] {
    return getDb()
      .prepare('SELECT * FROM torrent_events WHERE torrent_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(torrentId);
  },
};

// ---------- Audit log ----------

export const AuditLog = {
  record(userId: number | null, action: string, targetType?: string, targetId?: string, details?: object, ip?: string): void {
    getDb()
      .prepare(
        `INSERT INTO audit_log (user_id, action, target_type, target_id, details, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        action,
        targetType ?? null,
        targetId ?? null,
        details ? JSON.stringify(details) : null,
        ip ?? null
      );
  },
  recent(limit = 100): AuditLogEntry[] {
    return getDb()
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
      .all(limit) as AuditLogEntry[];
  },
};

// ---------- Settings ----------

export const Settings = {
  get(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  },
  set(key: string, value: string): void {
    getDb()
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  },
  all(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
};

// ---------- Login attempts (brute force protection) ----------

export const LoginAttempts = {
  record(identifier: string, app: 'panel' | 'portal', success: boolean, ip?: string): void {
    getDb()
      .prepare(
        'INSERT INTO login_attempts (identifier, app, success, ip_address) VALUES (?, ?, ?, ?)'
      )
      .run(identifier, app, success ? 1 : 0, ip ?? null);
  },
  recentFailures(identifier: string, app: 'panel' | 'portal', sinceMs: number): number {
    const sinceIso = new Date(Date.now() - sinceMs).toISOString();
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) as c FROM login_attempts
         WHERE identifier = ? AND app = ? AND success = 0 AND created_at >= ?`
      )
      .get(identifier, app, sinceIso) as { c: number };
    return row.c;
  },
};
