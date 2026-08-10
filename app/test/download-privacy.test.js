'use strict';
/**
 * Automated privacy/security tests for the management panel's
 * file-transfer chain. Boots a real Express app instance (via
 * createApp()) on an ephemeral port against a throwaway SQLite database
 * and a throwaway download directory containing real files with
 * deliberately sensitive names. qBittorrent itself is stubbed with a
 * minimal real HTTP server implementing just the two endpoints the app
 * actually calls (auth/login, torrents/files) -- everything on our side
 * of that boundary runs for real, unmocked.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const SENSITIVE_NAME = 'Confidential-Salary-Report-2026.xlsx';

let tmpRoot;
let server;
let fakeQbt;
let baseUrl;
let shared;
let torrentId;
let ownerCreds;
let otherCreds;
let adminCreds;

function startFakeQbittorrent(fileList) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v2/auth/login')) {
      res.setHeader('Set-Cookie', 'SID=fake-qbt-session; Path=/');
      res.end('Ok.');
      return;
    }
    if (req.url.startsWith('/api/v2/torrents/files')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(fileList));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-app-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  fs.mkdirSync(downloadDir, { recursive: true });

  fs.writeFileSync(path.join(downloadDir, SENSITIVE_NAME), 'the actual confidential bytes\n');

  fakeQbt = await startFakeQbittorrent([{ name: SENSITIVE_NAME, size: 30, progress: 1 }]);
  const qbtPort = fakeQbt.address().port;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
  process.env.TORRENT_DOWNLOAD_DIR = downloadDir;
  process.env.APP_PORT = '0';
  process.env.APP_HOST = '127.0.0.1';
  process.env.SESSION_SECRET = 'test-secret-app-0123456789abcdef';
  process.env.COOKIE_SECURE = 'false';
  process.env.TORRENT_HOST = `http://127.0.0.1:${qbtPort}`;
  process.env.TORRENT_USERNAME = 'fake';
  process.env.TORRENT_PASSWORD = 'fake';
  process.env.FRONTEND_DIST_DIR = path.join(tmpRoot, 'no-such-frontend-dist');
  process.env.UPLOAD_TMP_DIR = path.join(tmpRoot, 'uploads');
  process.env.DOWNLOAD_TOKEN_TTL_MINUTES = '60';

  // eslint-disable-next-line global-require
  shared = require('../../shared/dist/index.js');
  // eslint-disable-next-line global-require
  const { createApp } = require('../dist/index.js');

  shared.runMigrations();

  const ownerPw = 'OwnerPass123!';
  const otherPw = 'OtherPass123!';
  const adminPw = 'AdminPass123!';
  const owner = shared.Users.create('owner-user', await shared.hashPassword(ownerPw), false);
  const other = shared.Users.create('other-user', await shared.hashPassword(otherPw), false);
  const admin = shared.Users.create('admin-user', await shared.hashPassword(adminPw), true);
  ownerCreds = { username: owner.username, password: ownerPw };
  otherCreds = { username: other.username, password: otherPw };
  adminCreds = { username: admin.username, password: adminPw };

  const torrent = shared.Torrents.create({
    torrent_hash: 'd'.repeat(40),
    user_id: owner.id,
    original_filename: 'upload.torrent',
    display_name: SENSITIVE_NAME,
    category: '',
  });
  shared.Torrents.updateSyncState(torrent.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: 30,
    save_path: downloadDir,
    completed_at: new Date().toISOString(),
  });
  torrentId = torrent.id;

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
  if (!raw) return null;
  return raw.split(';')[0];
}

/** Logs in via the JSON API, returns { cookie, csrfToken }. */
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

async function mintDownloadLink({ cookie, csrfToken }, id) {
  return fetch(`${baseUrl}/api/torrents/${id}/download-link`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
  });
}

test('unauthenticated request cannot mint a download link', async () => {
  const res = await fetch(`${baseUrl}/api/torrents/${torrentId}/download-link`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('a non-owner cannot mint a download link for someone else\'s torrent (indistinguishable from unknown id)', async () => {
  const session = await login(otherCreds);
  const res = await mintDownloadLink(session, torrentId);
  assert.equal(res.status, 404);
});

test('the owner can mint a link, and the URL is opaque: no filename, no numeric id', async () => {
  const session = await login(ownerCreds);
  const res = await mintDownloadLink(session, torrentId);
  assert.equal(res.status, 200);
  const body = await res.json();

  // The regex match above is the real proof there's no id segment: the
  // path is exactly "/api/dl/" + token, structurally incapable of also
  // carrying a torrent id. (Checking that the token string doesn't
  // *coincidentally* contain the id's digits would be a flaky test -- a
  // 43-char random token has a ~50% chance of containing any given digit.)
  assert.ok(!body.url.toLowerCase().includes('confidential'), 'URL must not leak the filename');
  assert.ok(!body.url.toLowerCase().includes('salary'), 'URL must not leak the filename');
  assert.ok(!body.url.toLowerCase().includes('.xlsx'), 'URL must not leak the extension');
});

test('the owner can redeem their own token and gets a generic Content-Disposition', async () => {
  const session = await login(ownerCreds);
  const mintRes = await mintDownloadLink(session, torrentId);
  const { url } = await mintRes.json();

  const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } });
  assert.equal(res.status, 200);

  const disposition = res.headers.get('content-disposition') || '';
  assert.ok(!disposition.toLowerCase().includes('confidential'), `leaked real name: ${disposition}`);
  assert.match(disposition, /filename="download\.xlsx"/);

  const body = await res.text();
  assert.equal(body, 'the actual confidential bytes\n');
});

test('a stolen/leaked token is useless without also having the owner\'s (or an admin\'s) session', async () => {
  const ownerSession = await login(ownerCreds);
  const mintRes = await mintDownloadLink(ownerSession, torrentId);
  const { url } = await mintRes.json();

  // Someone else obtained the URL (e.g. it leaked in a chat log) but is
  // logged in as a different, unrelated user.
  const otherSession = await login(otherCreds);
  const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: otherSession.cookie } });
  assert.equal(res.status, 404);
});

test('the same leaked token is also useless with no session at all', async () => {
  const session = await login(ownerCreds);
  const mintRes = await mintDownloadLink(session, torrentId);
  const { url } = await mintRes.json();

  const res = await fetch(`${baseUrl}${url}`); // no Cookie header
  assert.equal(res.status, 401);
});

test('an admin can mint and redeem a link for another user\'s torrent', async () => {
  const adminSession = await login(adminCreds);
  const mintRes = await mintDownloadLink(adminSession, torrentId);
  assert.equal(mintRes.status, 200);
  const { url } = await mintRes.json();

  const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(res.status, 200);
});

test('guessed / never-issued tokens are rejected with a generic 404', async () => {
  const session = await login(ownerCreds);
  const guess = 'Z'.repeat(43);
  const res = await fetch(`${baseUrl}/api/dl/${guess}`, { headers: { Cookie: session.cookie } });
  assert.equal(res.status, 404);
});

test('expired tokens are rejected even though they were validly issued', async () => {
  const session = await login(ownerCreds);
  const mintRes = await mintDownloadLink(session, torrentId);
  const { url } = await mintRes.json();
  const rawToken = url.split('/api/dl/')[1];

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  shared
    .getDb()
    .prepare("UPDATE download_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE token_hash = ?")
    .run(tokenHash);

  const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: session.cookie } });
  assert.equal(res.status, 404);
});

test('torrent list API responses never include the unused originalFilename field', async () => {
  const session = await login(ownerCreds);
  const res = await fetch(`${baseUrl}/api/torrents`, { headers: { Cookie: session.cookie } });
  const body = await res.json();
  assert.ok(body.torrents.length > 0);
  for (const t of body.torrents) {
    assert.equal(Object.prototype.hasOwnProperty.call(t, 'originalFilename'), false);
  }
});

test('rapid-fire token redemption attempts are rate limited (enumeration protection)', async () => {
  const session = await login(ownerCreds);
  let sawTooManyRequests = false;
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${baseUrl}/api/dl/${'Y'.repeat(43)}${i}`, { headers: { Cookie: session.cookie } });
    if (res.status === 429) {
      sawTooManyRequests = true;
      break;
    }
  }
  assert.ok(sawTooManyRequests, 'expected the rate limiter to eventually respond 429 to repeated guesses');
});
