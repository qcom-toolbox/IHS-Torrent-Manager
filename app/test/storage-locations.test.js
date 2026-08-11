'use strict';
/**
 * Automated tests for admin-managed storage locations (multi-disk
 * support). Boots a real app instance against a throwaway DB and real
 * directories on disk (a "default" download dir plus a second,
 * separate directory standing in for an extra disk), driven over real
 * HTTP, with a fake qBittorrent stub.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tmpRoot;
let server;
let fakeQbt;
let baseUrl;
let shared;
let adminCreds;
let userCreds;
let secondDiskDir;

function startFakeQbittorrent() {
  const addedSavePaths = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/v2/auth/login')) {
      res.setHeader('Set-Cookie', 'SID=fake-qbt-session; Path=/');
      res.end('Ok.');
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/v2/torrents/add')) {
      let body = Buffer.alloc(0);
      req.on('data', (c) => (body = Buffer.concat([body, c])));
      req.on('end', () => {
        const text = body.toString('latin1');
        const m = text.match(/name="savepath"\r\n\r\n([^\r\n]*)/);
        addedSavePaths.push(m ? m[1] : null);
        res.end('Ok.');
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, addedSavePaths })));
}

let addedSavePaths;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-storage-loc-test-'));
  const downloadDir = path.join(tmpRoot, 'default-torrents');
  fs.mkdirSync(downloadDir, { recursive: true });
  secondDiskDir = path.join(tmpRoot, 'second-disk');
  fs.mkdirSync(secondDiskDir, { recursive: true });

  const stub = await startFakeQbittorrent();
  fakeQbt = stub.server;
  addedSavePaths = stub.addedSavePaths;
  const qbtPort = fakeQbt.address().port;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
  process.env.TORRENT_DOWNLOAD_DIR = downloadDir;
  process.env.APP_PORT = '0';
  process.env.APP_HOST = '127.0.0.1';
  process.env.SESSION_SECRET = 'test-secret-storage-loc-0123456789abcdef';
  process.env.COOKIE_SECURE = 'false';
  process.env.TORRENT_HOST = `http://127.0.0.1:${qbtPort}`;
  process.env.TORRENT_USERNAME = 'fake';
  process.env.TORRENT_PASSWORD = 'fake';
  process.env.FRONTEND_DIST_DIR = path.join(tmpRoot, 'no-such-frontend-dist');
  process.env.UPLOAD_TMP_DIR = path.join(tmpRoot, 'uploads');

  // eslint-disable-next-line global-require
  shared = require('../../shared/dist/index.js');
  // eslint-disable-next-line global-require
  const { createApp } = require('../dist/index.js');

  shared.runMigrations();

  const adminPw = 'AdminPass123!';
  const userPw = 'UserPass123!';
  const admin = shared.Users.create('sl-admin', await shared.hashPassword(adminPw), true);
  const user = shared.Users.create('sl-user', await shared.hashPassword(userPw), false);
  adminCreds = { username: admin.username, password: adminPw };
  userCreds = { username: user.username, password: userPw };

  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fakeQbt?.close();
  shared?.closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

async function login(creds) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  });
  assert.equal(res.status, 200, `login should succeed for ${creds.username}`);
  const cookie = extractCookie(res);
  const body = await res.json();
  return { cookie, csrfToken: body.csrfToken };
}

test('unauthenticated request cannot list or manage admin storage locations', async () => {
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`);
  assert.equal(res.status, 401);
});

test('a non-admin user cannot add a storage location, but can see the (minimal) location list for uploads', async () => {
  const session = await login(userCreds);
  const adminList = await fetch(`${baseUrl}/api/admin/storage-locations`, { headers: { Cookie: session.cookie } });
  assert.equal(adminList.status, 403);

  const uploadList = await fetch(`${baseUrl}/api/torrents/storage-locations`, { headers: { Cookie: session.cookie } });
  assert.equal(uploadList.status, 200);
  const body = await uploadList.json();
  assert.deepEqual(body.locations, [{ id: null, label: 'Default', isDefault: true }]);
});

test('admin sees the default location with real disk stats even with no extra locations configured', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`, { headers: { Cookie: session.cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.locations.length, 1);
  assert.equal(body.locations[0].isDefault, true);
  assert.equal(body.locations[0].id, null);
  assert.ok(body.locations[0].disk, 'should have real disk stats from df, not a stub');
  assert.equal(typeof body.locations[0].disk.totalBytes, 'number');
});

test('rejects a relative path outright (never silently resolved against the server process cwd)', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Bad', path: 'relative/path' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /absolute/i);
});

test('rejects a path that does not exist on the server', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Nope', path: path.join(tmpRoot, 'does-not-exist') }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /does not exist/i);
});

let addedLocationId;

test('admin can add a real, writable second directory as a storage location', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Second Disk', path: secondDiskDir }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.location.label, 'Second Disk');
  assert.equal(body.location.path, secondDiskDir);
  addedLocationId = body.location.id;

  const listRes = await fetch(`${baseUrl}/api/admin/storage-locations`, { headers: { Cookie: session.cookie } });
  const listBody = await listRes.json();
  assert.equal(listBody.locations.length, 2);
  const added = listBody.locations.find((l) => l.id === addedLocationId);
  assert.ok(added);
  assert.equal(added.torrentCount, 0);
});

test('adding the same path twice is rejected as a duplicate', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Dup', path: secondDiskDir }),
  });
  assert.equal(res.status, 409);
});

test('the new location now appears in the non-admin upload-time list', async () => {
  const session = await login(userCreds);
  const res = await fetch(`${baseUrl}/api/torrents/storage-locations`, { headers: { Cookie: session.cookie } });
  const body = await res.json();
  assert.equal(body.locations.length, 2);
  assert.ok(body.locations.some((l) => l.id === addedLocationId && l.label === 'Second Disk'));
});

test('uploading a torrent with an unknown storageLocationId is rejected', async () => {
  const session = await login(userCreds);
  const torrentBuf = Buffer.from(
    'd8:announce20:http://tracker.local4:infod6:lengthi100e4:name9:sldisk1.x12:piece lengthi16384e6:pieces20:' +
      'A'.repeat(20) +
      'ee'
  );
  const form = new FormData();
  form.append('torrent', new Blob([torrentBuf]), 'sldisk1.torrent');
  form.append('storageLocationId', '999999');

  const res = await fetch(`${baseUrl}/api/torrents/upload`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: form,
  });
  assert.equal(res.status, 400);
});

test('uploading a torrent selecting the second disk actually saves it there (real add-torrent call inspected)', async () => {
  const session = await login(userCreds);
  const torrentBuf = Buffer.from(
    'd8:announce20:http://tracker.local4:infod6:lengthi100e4:name9:sldisk2.x12:piece lengthi16384e6:pieces20:' +
      'B'.repeat(20) +
      'ee'
  );
  const form = new FormData();
  form.append('torrent', new Blob([torrentBuf]), 'sldisk2.torrent');
  form.append('storageLocationId', String(addedLocationId));

  addedSavePaths.length = 0;
  const res = await fetch(`${baseUrl}/api/torrents/upload`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    body: form,
  });
  assert.equal(res.status, 201);

  assert.ok(addedSavePaths.includes(secondDiskDir), `expected qBittorrent to be told to save into ${secondDiskDir}, got: ${addedSavePaths}`);
});

test('cannot delete a storage location that torrents still reference', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations/${addedLocationId}`, {
    method: 'DELETE',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
  });
  assert.equal(res.status, 409);
});

test('deleting a non-existent/invalid location id returns 404 (there is no numeric id for the default location to begin with)', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/storage-locations/not-a-number`, {
    method: 'DELETE',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
  });
  assert.equal(res.status, 404);
});
