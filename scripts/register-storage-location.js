#!/usr/bin/env node
/**
 * Registers an additional storage location in the database. Run by
 * scripts/add-storage-path.sh *after* it has already granted the path
 * write access at the systemd-sandbox level -- by the time this runs,
 * the path should genuinely be writable by the service user.
 *
 *   DATABASE_PATH=/path/to/db.sqlite node register-storage-location.js <path> <label>
 */
const path = require('path');
const shared = require(path.join(__dirname, '..', 'shared', 'dist', 'index.js'));

function main() {
  const [rawPath, label] = process.argv.slice(2);
  if (!rawPath || !label) {
    console.error('Usage: register-storage-location.js <absolute-path> <label>');
    process.exit(1);
  }
  const absolutePath = path.resolve(rawPath);

  shared.runMigrations();

  if (shared.StorageLocations.findByPath(absolutePath)) {
    console.log(`Storage location already registered: ${absolutePath}`);
    process.exit(0);
  }

  const check = shared.checkStorageLocationWritable(absolutePath);
  if (!check.ok) {
    console.error(`Path is not writable by the application: ${check.reason}`);
    console.error('The systemd sandbox update may not have taken effect yet -- confirm the services were restarted.');
    process.exit(1);
  }

  const location = shared.StorageLocations.create(label, absolutePath);
  console.log(`Registered storage location #${location.id}: "${label}" -> ${absolutePath}`);
  process.exit(0);
}

main();
