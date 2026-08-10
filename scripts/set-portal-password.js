#!/usr/bin/env node
/**
 * Sets (or resets) the download portal's shared password. Used
 * non-interactively by install.sh; safe to run manually:
 *
 *   DATABASE_PATH=/path/to/db.sqlite node scripts/set-portal-password.js <password>
 */
const path = require('path');
const shared = require(path.join(__dirname, '..', 'shared', 'dist', 'index.js'));

async function main() {
  const [password] = process.argv.slice(2);
  if (!password || password.length < 8) {
    console.error('Usage: set-portal-password.js <password (min 8 chars)>');
    process.exit(1);
  }
  shared.runMigrations();
  const hash = await shared.hashPassword(password);
  shared.Settings.set('portal_password_hash', hash);
  console.log('Download portal password set.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to set portal password:', err);
  process.exit(1);
});
