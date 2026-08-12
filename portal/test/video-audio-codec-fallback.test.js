'use strict';
/**
 * Tests for the audio-codec fallback: some audio codecs (AC-3/DTS/TrueHD,
 * common on remuxed Blu-ray/DVD rips) simply aren't decodable by any
 * mainstream browser, container format aside. Verified directly against a
 * real AC-3 file with a Web Audio AnalyserNode: the video decoded and
 * played normally, the audio produced a flat, unchanging signal (pure
 * silence), no error event fired. A container-only remux (`-c:a copy`)
 * would reproduce the exact same silence, so for tracks like this the
 * server has to transcode *just the audio* to AAC -- video always stays
 * `-c:v copy` (never re-encoded).
 *
 * Skips entirely if `ffmpeg`/`ffprobe` aren't on PATH.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

let hasFfmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

const VIDEO_NAME = 'Confidential-AC3.mp4';
const skip = hasFfmpeg ? false : 'ffmpeg/ffprobe not found on PATH';

let tmpRoot;
let server;
let baseUrl;
let shared;
const PORTAL_PASSWORD = 'TestPortalPass123!';

before(async () => {
  if (!hasFfmpeg) return;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-portal-ac3-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  const videoDir = path.join(downloadDir, 'AC3Show');
  fs.mkdirSync(videoDir, { recursive: true });

  // A single AC-3 audio track -- not browser-decodable at all, container
  // aside. This is what a typical Blu-ray/DVD remux torrent looks like.
  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '192k',
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
  const owner = shared.Users.create('seed-owner-ac3', await shared.hashPassword('irrelevant-pw-123'), false);

  const torrent = shared.Torrents.create({
    torrent_hash: 'c'.repeat(40),
    user_id: owner.id,
    original_filename: 'ac3.torrent',
    display_name: 'AC3Show',
    category: '',
  });
  shared.Torrents.updateSyncState(torrent.torrent_hash, {
    status: 'completed',
    progress: 1,
    size: fs.statSync(path.join(videoDir, VIDEO_NAME)).size,
    save_path: downloadDir,
    completed_at: new Date().toISOString(),
  });

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
  assert.ok(m, 'expected a Watch action for the AC3 file');
  const res = await fetch(`${baseUrl}/create-watch-link/${m[1]}/${m[2]}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  assert.equal(res.status, 302);
  return res.headers.get('location').split('/watch/')[1];
}

test('a file whose only audio track is AC-3 is NOT routed through the plain (silent) fast path', { skip }, async () => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const page = await fetch(`${baseUrl}/watch/${token}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(
    html,
    /data-fast-path-eligible="false"/,
    'the AC-3 default track must not be marked fast-path-eligible'
  );
  const srcMatch = html.match(/<source src="([^"]+)"/);
  assert.ok(srcMatch, 'expected a <source> tag');
  assert.match(srcMatch[1], /\?track=0/, 'the initial source must already point at the transcode path, not the bare stream URL');
});

test('the AC-3 track actually gets transcoded to AAC (playable), video stays untouched (copy)', { skip }, async (t) => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);

  const res = await fetch(`${baseUrl}/stream/${token}?track=0`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');

  const outPath = path.join(tmpRoot, 'transcoded.mp4');
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  t.after(() => fs.rmSync(outPath, { force: true }));

  const probeJson = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type,codec_name',
    outPath,
  ]).toString();
  const streams = JSON.parse(probeJson).streams;

  const audio = streams.find((s) => s.codec_type === 'audio');
  assert.ok(audio, 'remuxed output must still have an audio stream');
  assert.equal(audio.codec_name, 'aac', 'AC-3 must be transcoded to a browser-decodable codec');

  const video = streams.find((s) => s.codec_type === 'video');
  assert.ok(video, 'video stream must still be present');
  assert.equal(video.codec_name, 'h264', 'video codec must be unchanged (copy, not re-encoded)');
});

test('the transcoded audio is not silent (sanity-checks the fix against the exact failure mode)', { skip }, async (t) => {
  const cookie = await loginToPortal();
  const token = await mintWatchLink(cookie);
  const res = await fetch(`${baseUrl}/stream/${token}?track=0`, { headers: { Cookie: cookie } });
  const outPath = path.join(tmpRoot, 'silence-check.mp4');
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  t.after(() => fs.rmSync(outPath, { force: true }));

  // volumedetect reports mean/max volume in dBFS (to stderr); true digital
  // silence reports mean_volume around -91dB (float noise floor). A real
  // 440Hz tone at this bitrate should land close to 0dB max, nowhere near that.
  const result = spawnSync('ffmpeg', ['-i', outPath, '-af', 'volumedetect', '-f', 'null', '-']);
  const out = result.stderr.toString();
  const match = out.match(/max_volume:\s*(-?\d+(\.\d+)?)\s*dB/);
  assert.ok(match, 'expected volumedetect output');
  assert.ok(Number(match[1]) > -20, `expected audible audio, got max_volume=${match[1]}dB (looks silent)`);
});
