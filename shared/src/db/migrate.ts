import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './connection';

function resolveMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) {
    return path.resolve(process.env.MIGRATIONS_DIR);
  }
  // shared/dist/db/migrate.js -> repo root /migrations
  return path.resolve(__dirname, '../../../migrations');
}

export function runMigrations(databasePath?: string, migrationsDir?: string): string[] {
  const db = getDb(databasePath);
  const dir = migrationsDir ?? resolveMigrationsDir();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const already = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r: any) => r.filename)
  );

  const applied: string[] = [];

  for (const file of files) {
    if (already.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });
    runMigration();
    applied.push(file);
  }

  return applied;
}

if (require.main === module) {
  try {
    const applied = runMigrations();
    if (applied.length === 0) {
      console.log('Database is already up to date. No migrations applied.');
    } else {
      console.log(`Applied ${applied.length} migration(s):`);
      for (const f of applied) console.log(`  - ${f}`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}
