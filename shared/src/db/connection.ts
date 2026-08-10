import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

let db: Database.Database | null = null;

export function getDb(databasePath?: string): Database.Database {
  if (db) return db;
  const dbPath = databasePath ?? process.env.DATABASE_PATH;
  if (!dbPath) {
    throw new Error('DATABASE_PATH is not set');
  }
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  db = new Database(resolved);
  // WAL mode allows the web app and the background worker to read/write
  // the same SQLite file concurrently without lock contention.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
