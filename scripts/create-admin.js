#!/usr/bin/env node
/**
 * Creates (or resets) the initial administrator account.
 * Used non-interactively by install.sh, but safe to run manually:
 *
 *   DATABASE_PATH=/path/to/db.sqlite node scripts/create-admin.js <username> <password>
 */
const path = require('path');

const shared = require(path.join(__dirname, '..', 'shared', 'dist', 'index.js'));

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: create-admin.js <username> <password>');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.\-]{3,32}$/.test(username)) {
    console.error('Username must be 3-32 characters: letters, numbers, _ . -');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exit(1);
  }

  shared.runMigrations();
  const existing = shared.Users.findByUsername(username);
  const hash = await shared.hashPassword(password);

  if (existing) {
    shared.Users.updatePassword(existing.id, hash);
    shared.Users.setAdmin(existing.id, true);
    console.log(`Updated existing user "${username}" and granted administrator rights.`);
  } else {
    shared.Users.create(username, hash, true);
    console.log(`Created administrator "${username}".`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create administrator:', err);
  process.exit(1);
});
