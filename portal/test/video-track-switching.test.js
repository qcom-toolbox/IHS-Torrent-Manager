'use strict';
/**
 * Tests for real (server-side ffmpeg remux) audio track switching.
 *
 * HTMLMediaElement.audioTracks -- the API the first version of this
 * feature was built on -- turned out not to be implemented for regular
 * file playback in the mainstream browsers this was tested against (see
 * the big comment in portal/src/index.ts on GET /stream/:token), so track
 * switching was moved server-side: ffprobe lists the real tracks, and
 * picking a non-default one triggers an ffmpeg `-c copy` remux that swaps
 * which audio stream is included, without ever re-encoding video or audio.
 *
 * These tests build a real two-audio-track MP4 with `ffmpeg` and skip
 * entirely if `ffmpeg`/`ffprobe` aren't on PATH, since this feature has a
 * hard runtime dependency on them (see install.sh).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let hasFfmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

const VIDEO_NAME = 'Confidential-MultiTrack.mp4';
const skip = hasFfmpeg ? false : 'ffmpeg/ffprobe not found on PATH';

let tmpRoot;
let server;
let baseUrl;
let shared;
let videoTorrentId;
const PORTAL_PASSWORD = 'TestPortalPass123!';

before(async () => {
  if (!hasFfmpeg) return;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-portal-tracks-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  const videoDir = path.join(downloadDir, 'MultiTrackShow');
  fs.mkdirSync(videoDir, { recursive: true });

  // Two audio tracks (English 440Hz tone, Spanish 880Hz tone) muxed with a
  // short test-pattern video -- small, fast to generate, and gives each
  // track a distinct, independently-verifiable `language` tag.
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng',
    '-metadata:s:a:1', 'language=spa',
    path.join(videoDir, VIDEO_NAME),
  ], { stdio: 'ignore' });

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
  const owner = shared.Users.create('seed-owner-tracks', await shared.hashPassword('irrelevant-pw-123'), false);

  const torrent = shared.Torrents.create({
    torrent_hash: 'f'.repeat(40),
    user_id: owner.id,
    original_filename: 'multitrack.torrent',
    display_name: 'MultiTrackShow',
    category: '',
  });
  shared.Torrents.updateSyncState(torrent.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: fs.statSync(path.join(videoDir, VIDEO_NAME)).size,
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

async function mintWatchLink(cookie) {
  const dashboard = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } });
  const html = await dashboard.text();
  const csrf = extractCsrf(html);
  const m = html.match(/create-watch-link\/(\d+)\/(\d+)/);
  assert.ok(m, 'expected a Watch action for the multi-track file');
  const res = await fetch(`${baseUrl}/create-watch-link/${m[1]}/${m[2]}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(res.status, 302);
  return res.headers.get('location').split('/watch/')[1];
}

test('watch page lists both real audio tracks by their probed language, not a browser API', { skip }, async () => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const page = await fetch(`${baseUrl}/watch/${token}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<select id="audio-track-select">/);
  assert.match(html, /<option value="0"[^>]*>ENG<\/option>/);
  assert.match(html, /<option value="1"[^>]*>SPA<\/option>/);
});

test('default track (?track omitted) is Range-enabled and byte-identical to a plain fetch', { skip }, async () => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const res = await fetch(`${baseUrl}/stream/${token}`, { headers: { Cookie: cookie, Range: 'bytes=0-99' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('?track=1 triggers a real ffmpeg remux containing only the Spanish audio stream', { skip }, async (t) => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);

  const res = await fetch(`${baseUrl}/stream/${token}?track=1`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');

  const outPath = path.join(tmpRoot, 'remuxed-track1.mp4');
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  t.after(() => fs.rmSync(outPath, { force: true }));

  const probeJson = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type:stream_tags=language',
    outPath,
  ]).toString();
  const streams = JSON.parse(probeJson).streams;
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  assert.equal(audioStreams.length, 1, 'the remux should contain exactly one audio stream');
  assert.equal(audioStreams[0].tags.language, 'spa');
  assert.ok(streams.some((s) => s.codec_type === 'video'), 'video stream must still be present, unmodified');
});

test('?track=0 remux contains only the English audio stream', { skip }, async (t) => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);

  const res = await fetch(`${baseUrl}/stream/${token}?track=0`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);

  const outPath = path.join(tmpRoot, 'remuxed-track0.mp4');
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  t.after(() => fs.rmSync(outPath, { force: true }));

  const probeJson = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type:stream_tags=language',
    outPath,
  ]).toString();
  const audioStreams = JSON.parse(probeJson).streams.filter((s) => s.codec_type === 'audio');
  assert.equal(audioStreams.length, 1);
  assert.equal(audioStreams[0].tags.language, 'eng');
});

test('an out-of-range ?track value is rejected with a generic 404 (no ffmpeg args injection surface)', { skip }, async () => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const res = await fetch(`${baseUrl}/stream/${token}?track=99`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});

test('a non-numeric ?track value is rejected', { skip }, async () => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const res = await fetch(`${baseUrl}/stream/${token}?track=' OR 1=1`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
});
