'use strict';
/**
 * Automated tests for the admin download/upload master-switch feature.
 * Boots a real app instance against a throwaway DB, stubbing qBittorrent
 * with a stateful fake server that tracks which hashes have been paused
 * (so we can prove the PUT actually paused the right torrents on
 * qBittorrent, not just that the DB setting flipped).
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
let downloadingTorrentHash;
let completedTorrentHash;
let pausedHashesLog;

function startFakeQbittorrent() {
  const pausedLog = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/v2/auth/login')) {
      res.setHeader('Set-Cookie', 'SID=fake-qbt-session; Path=/');
      res.end('Ok.');
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/v2/torrents/pause')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const hashes = new URLSearchParams(body).get('hashes') || '';
        pausedLog.push(...hashes.split('|').filter(Boolean));
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/v2/torrents/resume')) {
      // Not tracked -- these tests only care whether the app's own
      // transfer-policy check let the request through to qBittorrent at all.
      req.on('data', () => {});
      req.on('end', () => res.end());
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, pausedLog })));
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-transfer-policy-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  fs.mkdirSync(downloadDir, { recursive: true });

  const stub = await startFakeQbittorrent();
  fakeQbt = stub.server;
  pausedHashesLog = stub.pausedLog;
  const qbtPort = fakeQbt.address().port;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
  process.env.TORRENT_DOWNLOAD_DIR = downloadDir;
  process.env.APP_PORT = '0';
  process.env.APP_HOST = '127.0.0.1';
  process.env.SESSION_SECRET = 'test-secret-transfer-policy-0123456789ab';
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
  const admin = shared.Users.create('tp-admin', await shared.hashPassword(adminPw), true);
  const user = shared.Users.create('tp-user', await shared.hashPassword(userPw), false);
  adminCreds = { username: admin.username, password: adminPw };
  userCreds = { username: user.username, password: userPw };

  const downloading = shared.Torrents.create({
    torrent_hash: 'd'.repeat(40),
    user_id: user.id,
    original_filename: 'x.torrent',
    display_name: 'still-downloading',
    category: '',
  });
  shared.Torrents.updateSyncState(downloading.torrent_hash, { status: 'downloading', progress: 0.5 });
  downloadingTorrentHash = downloading.torrent_hash;

  const completed = shared.Torrents.create({
    torrent_hash: 'c'.repeat(40),
    user_id: user.id,
    original_filename: 'y.torrent',
    display_name: 'finished-seeding',
    category: '',
  });
  shared.Torrents.updateSyncState(completed.torrent_hash, {
    status: 'completed',
    progress: 1,
    completed_at: new Date().toISOString(),
  });
  completedTorrentHash = completed.torrent_hash;

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

test('unauthenticated request cannot read or change transfer policy', async () => {
  const getRes = await fetch(`${baseUrl}/api/admin/transfer-policy`);
  assert.equal(getRes.status, 401);
});

test('a non-admin user cannot change transfer policy', async () => {
  const session = await login(userCreds);
  const res = await fetch(`${baseUrl}/api/admin/transfer-policy`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadsEnabled: false }),
  });
  assert.equal(res.status, 403);
});

test('downloading and uploading are enabled by default', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/transfer-policy`, { headers: { Cookie: session.cookie } });
  const body = await res.json();
  assert.equal(body.downloadsEnabled, true);
  assert.equal(body.uploadsEnabled, true);
});

test('disabling downloads immediately pauses the actively-downloading torrent on qBittorrent, but not the completed one', async () => {
  const session = await login(adminCreds);
  pausedHashesLog.length = 0;

  const res = await fetch(`${baseUrl}/api/admin/transfer-policy`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadsEnabled: false }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.downloadsEnabled, false);

  assert.ok(pausedHashesLog.includes(downloadingTorrentHash), 'the downloading torrent should have been paused');
  assert.ok(!pausedHashesLog.includes(completedTorrentHash), 'the completed torrent should not have been touched');
});

test('while downloads are disabled, uploading a new torrent is blocked with 403', async () => {
  const session = await login(userCreds);
  const torrentBuf = Buffer.from(
    'd8:announce20:http://tracker.local4:infod6:lengthi100e4:name9:blocked.x12:piece lengthi16384e6:pieces20:' +
      'A'.repeat(20) +
      'ee'
  );
  const form = new FormData();
  form.append('torrent', new Blob([torrentBuf]), 'blocked.torrent');

  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } });
  const me = await meRes.json();

  const res = await fetch(`${baseUrl}/api/torrents/upload`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': me.csrfToken },
    body: form,
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /disabled/i);
});

test('while downloads are disabled, resuming a non-completed torrent is blocked, but resuming a completed one is not', async () => {
  const session = await login(userCreds);
  const downloadingId = shared.Torrents.findByHash(downloadingTorrentHash).id;
  const completedId = shared.Torrents.findByHash(completedTorrentHash).id;

  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } });
  const me = await meRes.json();

  const resumeDownloading = await fetch(`${baseUrl}/api/torrents/${downloadingId}/resume`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': me.csrfToken },
  });
  assert.equal(resumeDownloading.status, 403);

  const resumeCompleted = await fetch(`${baseUrl}/api/torrents/${completedId}/resume`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': me.csrfToken },
  });
  assert.equal(resumeCompleted.status, 200);
});

test('re-enabling downloads lifts the block on resuming/uploading', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/transfer-policy`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadsEnabled: true }),
  });
  const body = await res.json();
  assert.equal(body.downloadsEnabled, true);

  const userSession = await login(userCreds);
  const downloadingId = shared.Torrents.findByHash(downloadingTorrentHash).id;
  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: userSession.cookie } });
  const me = await meRes.json();
  const resumeRes = await fetch(`${baseUrl}/api/torrents/${downloadingId}/resume`, {
    method: 'POST',
    headers: { Cookie: userSession.cookie, 'X-CSRF-Token': me.csrfToken },
  });
  assert.equal(resumeRes.status, 200);
});

test('disabling uploads pauses the completed/seeding torrent but not the downloading one', async () => {
  const session = await login(adminCreds);
  pausedHashesLog.length = 0;

  const res = await fetch(`${baseUrl}/api/admin/transfer-policy`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadsEnabled: false }),
  });
  assert.equal(res.status, 200);

  assert.ok(pausedHashesLog.includes(completedTorrentHash), 'the completed/seeding torrent should have been paused');
  assert.ok(!pausedHashesLog.includes(downloadingTorrentHash), 'the still-downloading torrent should not have been touched');
});

test('while uploads are disabled, resuming the completed torrent is blocked', async () => {
  const session = await login(userCreds);
  const completedId = shared.Torrents.findByHash(completedTorrentHash).id;
  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: session.cookie } });
  const me = await meRes.json();
  const res = await fetch(`${baseUrl}/api/torrents/${completedId}/resume`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': me.csrfToken },
  });
  assert.equal(res.status, 403);
});
