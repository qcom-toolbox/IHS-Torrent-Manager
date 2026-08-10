'use strict';
/**
 * Reproduces the exact failure reported against a real qBittorrent 5.x
 * install: /api/v2/torrents/pause returns 404 (renamed to
 * /api/v2/torrents/stop in the WebAPI qBittorrent 5.0 shipped), which
 * made every pause-based action fail, including the transfer-policy
 * enforcement. Verifies QbittorrentClient falls back to the new endpoint
 * name automatically, and that a genuinely fresh client (simulating
 * "same qBittorrent version, brand new process") resolves it again
 * without needing any config change.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let fakeQbt;
let baseUrl;
let calls;
let shared;

/** Simulates a qBittorrent 5.x install: /pause and /resume 404, only /stop and /start exist. */
function startV5StyleFakeQbittorrent() {
  calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.url.startsWith('/api/v2/auth/login')) {
      res.setHeader('Set-Cookie', 'SID=fake-qbt-session; Path=/');
      res.end('Ok.');
      return;
    }
    if (req.url.startsWith('/api/v2/torrents/pause') || req.url.startsWith('/api/v2/torrents/resume')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    if (req.url.startsWith('/api/v2/torrents/stop') || req.url.startsWith('/api/v2/torrents/start')) {
      req.on('data', () => {});
      req.on('end', () => res.end('Ok.'));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  fakeQbt = await startV5StyleFakeQbittorrent();
  // eslint-disable-next-line global-require
  shared = require('../../shared/dist/index.js');
});

after(() => {
  fakeQbt?.close();
});

test('pause() falls back from /pause (404) to /stop and succeeds, against a v5-style server', async () => {
  const client = new shared.QbittorrentClient(`http://127.0.0.1:${fakeQbt.address().port}`, 'fake', 'fake');
  await client.pause(['a'.repeat(40)]);

  assert.ok(calls.includes('POST /api/v2/torrents/pause'), 'should have tried the old endpoint first');
  assert.ok(calls.includes('POST /api/v2/torrents/stop'), 'should have fallen back to the new endpoint');
});

test('resume() falls back from /resume (404) to /start and succeeds', async () => {
  const client = new shared.QbittorrentClient(`http://127.0.0.1:${fakeQbt.address().port}`, 'fake', 'fake');
  await client.resume(['b'.repeat(40)]);

  assert.ok(calls.includes('POST /api/v2/torrents/resume'));
  assert.ok(calls.includes('POST /api/v2/torrents/start'));
});

test('once resolved, subsequent pause() calls on the same client go straight to /stop (no repeated 404 probing)', async () => {
  const client = new shared.QbittorrentClient(`http://127.0.0.1:${fakeQbt.address().port}`, 'fake', 'fake');
  await client.pause(['c'.repeat(40)]); // resolves and caches
  calls.length = 0;
  await client.pause(['d'.repeat(40)]);

  assert.deepEqual(calls, ['POST /api/v2/torrents/stop'], 'second call should skip straight to the cached endpoint');
});
