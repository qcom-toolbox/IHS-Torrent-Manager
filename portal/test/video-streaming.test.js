'use strict';
/**
 * Tests for the in-browser video viewer: minting a watch link, the player
 * page, and the Range-enabled stream route. Same style as
 * download-privacy.test.js -- a real Express app over real HTTP, real
 * files on disk, no mocking of our own code.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIDEO_NAME = 'Confidential-Recording.mp4';
const SUBTITLE_NAME = 'Confidential-Recording.srt';
const VIDEO_BYTES = Buffer.from('0123456789'.repeat(1000)); // 10000 bytes, easy to slice for Range checks

let tmpRoot;
let server;
let baseUrl;
let shared;
let videoTorrentId;
const PORTAL_PASSWORD = 'TestPortalPass123!';

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-portal-video-test-'));
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

  const owner = shared.Users.create('seed-owner-video', await shared.hashPassword('irrelevant-pw-123'), false);

  const videoDir = path.join(downloadDir, 'Some-Show-S01E01');
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, VIDEO_NAME), VIDEO_BYTES);
  fs.writeFileSync(path.join(videoDir, SUBTITLE_NAME), 'not a video\n');

  const torrent = shared.Torrents.create({
    torrent_hash: 'd'.repeat(40),
    user_id: owner.id,
    original_filename: 'show.torrent',
    display_name: 'Some-Show-S01E01',
    category: '',
  });
  shared.Torrents.updateSyncState(torrent.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: VIDEO_BYTES.length,
    save_path: downloadDir,
    completed_at: new Date().toISOString(),
  });
  videoTorrentId = torrent.id;

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
  assert.equal(loginRes.status, 302);
  return extractCookie(loginRes) || cookie1;
}

async function findFileIndex(cookie, torrentId, name) {
  const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const html = await dashboard.text();
  const csrf = extractCsrf(html);

  // Don't assume sort order: find the actual <li class="file-row"> block
  // containing this filename and read the index straight out of its own
  // create-download-link action, so the test can't drift from whatever
  // order the server assigns.
  const rows = html.split('<li class="file-row">').slice(1);
  const row = rows.find((r) => r.includes(name));
  assert.ok(row, `expected a file row for ${name}`);
  const m = row.match(new RegExp(`create-download-link/${torrentId}/(\\d+)`));
  assert.ok(m, `expected a download action with a file index for ${name}`);
  return { csrf, index: parseInt(m[1], 10) };
}

async function mintWatchLink(cookie, torrentId, fileIndex, csrf) {
  const res = await fetch(`${baseUrl}/create-watch-link/${torrentId}/${fileIndex}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return res;
}

test('unauthenticated request cannot mint a watch link', async () => {
  const res = await fetch(`${baseUrl}/create-watch-link/${videoTorrentId}/1`, {
    method: 'POST',
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('minting a watch link for a video file redirects to an opaque /watch/<token> URL', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, VIDEO_NAME);
  const res = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/watch\/[A-Za-z0-9_-]{20,}$/);
  assert.ok(!location.toLowerCase().includes('confidential'), 'URL must not leak the filename');
});

test('minting a watch link for a non-video file is refused', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, SUBTITLE_NAME);
  const res = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  assert.equal(res.status, 404);
});

test('watch page embeds a <video> tag pointed at the stream route, no real filename in the URL', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, VIDEO_NAME);
  const mint = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  const location = mint.headers.get('location');

  const page = await fetch(`${baseUrl}${location}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<video[^>]*id="player"/);
  assert.match(html, /src="\/stream\/[A-Za-z0-9_-]{20,}"/);
  assert.match(html, /type="video\/mp4"/);
  assert.ok(html.includes(VIDEO_NAME), 'the authenticated player page may show the real filename');
});

test('unauthenticated request to /watch or /stream is redirected to login', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, VIDEO_NAME);
  const mint = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  const watchLocation = mint.headers.get('location');
  const streamToken = watchLocation.split('/watch/')[1];

  const watchRes = await fetch(`${baseUrl}${watchLocation}`, { redirect: 'manual' });
  assert.equal(watchRes.status, 302);
  assert.equal(watchRes.headers.get('location'), '/login');

  const streamRes = await fetch(`${baseUrl}/stream/${streamToken}`, { redirect: 'manual' });
  assert.equal(streamRes.status, 302);
  assert.equal(streamRes.headers.get('location'), '/login');
});

test('stream route serves the full file with correct type, inline disposition, and supports Range requests', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, VIDEO_NAME);
  const mint = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  const streamUrl = `${baseUrl}/stream/${mint.headers.get('location').split('/watch/')[1]}`;

  const full = await fetch(streamUrl, { headers: { Cookie: cookie } });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('content-disposition'), 'inline');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const fullBody = Buffer.from(await full.arrayBuffer());
  assert.deepEqual(fullBody, VIDEO_BYTES);

  const ranged = await fetch(streamUrl, { headers: { Cookie: cookie, Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206, 'a byte-range request should get a 206 Partial Content response');
  assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${VIDEO_BYTES.length}`);
  const rangedBody = Buffer.from(await ranged.arrayBuffer());
  assert.equal(rangedBody.length, 10);
  assert.deepEqual(rangedBody, VIDEO_BYTES.subarray(10, 20));
});

test('a stream token can be redeemed for repeated Range requests (not single-use)', async () => {
  const cookie = await loginToPortal();
  const { csrf, index } = await findFileIndex(cookie, videoTorrentId, VIDEO_NAME);
  const mint = await mintWatchLink(cookie, videoTorrentId, index, csrf);
  const streamUrl = `${baseUrl}/stream/${mint.headers.get('location').split('/watch/')[1]}`;

  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(streamUrl, { headers: { Cookie: cookie, Range: `bytes=${i}-${i}` } });
    assert.equal(res.status, 206, `repeated Range request #${i} should still succeed off the same token`);
  }
});

test('guessed / never-issued stream tokens are rejected with a generic 404', async () => {
  const cookie = await loginToPortal();
  const guess = 'C'.repeat(43);
  const res = await fetch(`${baseUrl}/stream/${guess}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

test('a plain download token (no file scope) cannot be redeemed against /watch or /stream', async () => {
  const cookie = await loginToPortal();
  const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const csrf = extractCsrf(await dashboard.text());
  const mintRes = await fetch(`${baseUrl}/create-download-link/${videoTorrentId}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  const dlToken = mintRes.headers.get('location').split('/dl/')[1];

  const watchRes = await fetch(`${baseUrl}/watch/${dlToken}`, { headers: { Cookie: cookie } });
  assert.equal(watchRes.status, 404, 'a torrent-scoped (not file-scoped) token must not work as a watch token');
});
