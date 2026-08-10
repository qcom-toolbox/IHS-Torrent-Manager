'use strict';
/**
 * Automated privacy/security tests for the download portal's file-transfer
 * chain. Boots a real Express app instance (via createApp()) on an
 * ephemeral port against a throwaway SQLite database and a throwaway
 * download directory containing real files with deliberately sensitive
 * names, then drives it over real HTTP with the global fetch client --
 * no mocking of our own code, only the parts of the world outside our
 * control (there is none here: the portal never talks to qBittorrent).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SENSITIVE_NAME = 'Confidential-Salary-Report-2026.xlsx';
const SENSITIVE_MULTI_NAME = 'Project-Nightingale-Leaked-Docs';

let tmpRoot;
let server;
let baseUrl;
let shared;
let singleFileTorrentId;
let multiFileTorrentId;
const PORTAL_PASSWORD = 'TestPortalPass123!';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-portal-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  fs.mkdirSync(downloadDir, { recursive: true });

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
  process.env.TORRENT_DOWNLOAD_DIR = downloadDir;
  process.env.PORTAL_SESSION_SECRET = 'test-secret-portal-0123456789abcdef';
  process.env.COOKIE_SECURE = 'false';
  process.env.DOWNLOAD_TOKEN_TTL_MINUTES = '60';

  // eslint-disable-next-line global-require
  shared = require('../../shared/dist/index.js');
  // eslint-disable-next-line global-require
  const { createApp } = require('../dist/index.js');

  shared.runMigrations();

  const passwordHash = await shared.hashPassword(PORTAL_PASSWORD);
  shared.Settings.set('portal_password_hash', passwordHash);

  const owner = shared.Users.create('seed-owner', await shared.hashPassword('irrelevant-pw-123'), false);

  // Single-file completed torrent with a sensitive real name.
  fs.writeFileSync(path.join(downloadDir, SENSITIVE_NAME), 'the actual confidential bytes\n');
  const single = shared.Torrents.create({
    torrent_hash: 'a'.repeat(40),
    user_id: owner.id,
    original_filename: 'upload.torrent',
    display_name: SENSITIVE_NAME,
    category: '',
  });
  shared.Torrents.updateSyncState(single.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: 30,
    save_path: downloadDir,
    completed_at: new Date().toISOString(),
  });
  singleFileTorrentId = single.id;

  // Multi-file completed torrent (directory) with a sensitive real name.
  const multiDir = path.join(downloadDir, SENSITIVE_MULTI_NAME);
  fs.mkdirSync(multiDir, { recursive: true });
  fs.writeFileSync(path.join(multiDir, 'evidence-1.pdf'), 'file one bytes\n');
  fs.writeFileSync(path.join(multiDir, 'evidence-2.pdf'), 'file two bytes\n');
  const multi = shared.Torrents.create({
    torrent_hash: 'b'.repeat(40),
    user_id: owner.id,
    original_filename: 'upload2.torrent',
    display_name: SENSITIVE_MULTI_NAME,
    category: '',
  });
  shared.Torrents.updateSyncState(multi.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: 30,
    save_path: downloadDir,
    completed_at: new Date().toISOString(),
  });
  multiFileTorrentId = multi.id;

  const app = createApp();
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  shared?.closeDb();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, 'expected a _csrf hidden field in the rendered page');
  return m[1];
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

/** Logs into the portal, returns a Cookie header value for the authenticated session. */
async function loginToPortal() {
  const loginPage = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
  const cookie1 = extractCookie(loginPage);
  const csrf1 = extractCsrf(await loginPage.text());

  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie1 },
    body: new URLSearchParams({ _csrf: csrf1, password: PORTAL_PASSWORD }).toString(),
  });
  assert.equal(loginRes.status, 302, 'login should redirect on success');
  const cookie2 = extractCookie(loginRes) || cookie1;
  return cookie2;
}

async function mintDownloadLink(cookie, torrentId) {
  const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await dashboard.text());
  const mintRes = await fetch(`${baseUrl}/create-download-link/${torrentId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(mintRes.status, 302, 'minting a link should redirect to the opaque URL');
  return mintRes.headers.get('location');
}

test('unauthenticated request to the dashboard is redirected to login, never shows torrent data', async () => {
  const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('unauthenticated request cannot mint a download link', async () => {
  const res = await fetch(`${baseUrl}/create-download-link/${singleFileTorrentId}`, {
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('minted download URL is opaque: no real filename, no numeric torrent id', async () => {
  const cookie = await loginToPortal();
  const location = await mintDownloadLink(cookie, singleFileTorrentId);

  assert.match(location, /^\/dl\/[A-Za-z0-9_-]{20,}$/, 'URL should be /dl/<opaque token>');
  // The regex match above is the real proof there's no id segment: the
  // path is exactly "/dl/" + token, structurally incapable of also
  // carrying a torrent id. (Checking that the token string doesn't
  // *coincidentally* contain the id's digits would be a flaky test -- a
  // 43-char random token has a ~50% chance of containing any given digit.)
  assert.ok(!location.toLowerCase().includes('confidential'), 'URL must not leak the filename');
  assert.ok(!location.toLowerCase().includes('.xlsx'), 'URL must not leak the extension');
});

test('redeeming a valid token as an unauthenticated client is refused (session still required)', async () => {
  const cookie = await loginToPortal();
  const location = await mintDownloadLink(cookie, singleFileTorrentId);

  const res = await fetch(`${baseUrl}${location}`, { redirect: 'manual' }); // no Cookie header at all
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('authenticated redemption serves the real bytes with a generic Content-Disposition (single file)', async () => {
  const cookie = await loginToPortal();
  const location = await mintDownloadLink(cookie, singleFileTorrentId);

  const res = await fetch(`${baseUrl}${location}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);

  const disposition = res.headers.get('content-disposition') || '';
  assert.ok(!disposition.toLowerCase().includes('confidential'), `Content-Disposition leaked the real name: ${disposition}`);
  assert.ok(!disposition.toLowerCase().includes('salary'), `Content-Disposition leaked the real name: ${disposition}`);
  assert.match(disposition, /filename="download\.xlsx"/, 'expected a generic "download.xlsx" filename');

  const body = await res.text();
  assert.equal(body, 'the actual confidential bytes\n', 'the actual file content must still be delivered correctly');
});

test('authenticated redemption of a multi-file torrent serves a generically named zip', async () => {
  const cookie = await loginToPortal();
  const location = await mintDownloadLink(cookie, multiFileTorrentId);

  const res = await fetch(`${baseUrl}${location}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const disposition = res.headers.get('content-disposition') || '';
  assert.ok(!disposition.toLowerCase().includes('nightingale'), `Content-Disposition leaked the real name: ${disposition}`);
  assert.match(disposition, /filename="download\.zip"/);
});

test('guessed / never-issued tokens are rejected with a generic 404', async () => {
  const cookie = await loginToPortal();
  const guess = 'A'.repeat(43); // same shape as a real token, never issued
  const res = await fetch(`${baseUrl}/dl/${guess}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

test('expired tokens are rejected even though they were validly issued', async () => {
  const cookie = await loginToPortal();
  const location = await mintDownloadLink(cookie, singleFileTorrentId);
  const rawToken = location.split('/dl/')[1];

  // Force-expire it directly in the DB, simulating time passing.
  const tokenHash = require('node:crypto').createHash('sha256').update(rawToken).digest('hex');
  shared.getDb()
    .prepare("UPDATE download_tokens SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE token_hash = ?")
    .run(tokenHash);

  const res = await fetch(`${baseUrl}${location}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

test('a torrent that is not completed cannot be linked or downloaded', async () => {
  const cookie = await loginToPortal();
  const notCompleted = shared.Torrents.create({
    torrent_hash: 'c'.repeat(40),
    user_id: 1,
    original_filename: 'x.torrent',
    display_name: 'still-downloading',
    category: '',
  });

  const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await dashboard.text());
  const res = await fetch(`${baseUrl}/create-download-link/${notCompleted.id}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(res.status, 404);
});

test('rapid-fire token redemption attempts are rate limited (enumeration protection)', async () => {
  const cookie = await loginToPortal();
  let sawTooManyRequests = false;
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${baseUrl}/dl/${'B'.repeat(43)}${i}`, { headers: { Cookie: cookie } });
    if (res.status === 429) {
      sawTooManyRequests = true;
      break;
    }
  }
  assert.ok(sawTooManyRequests, 'expected the rate limiter to eventually respond 429 to repeated guesses');
});
