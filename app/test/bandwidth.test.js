'use strict';
/**
 * Automated tests for the admin bandwidth-limit endpoints. Boots a real
 * app instance against a throwaway DB, stubbing qBittorrent with a
 * minimal real HTTP server that tracks limit state across requests (so
 * a PUT followed by a GET proves the round trip actually works, not just
 * that each call individually returns 200).
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

function startFakeQbittorrent() {
  const state = { downloadLimit: 0, uploadLimit: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/v2/auth/login')) {
      res.setHeader('Set-Cookie', 'SID=fake-qbt-session; Path=/');
      res.end('Ok.');
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v2/transfer/downloadLimit')) {
      res.end(String(state.downloadLimit));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/v2/transfer/uploadLimit')) {
      res.end(String(state.uploadLimit));
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/v2/transfer/setDownloadLimit')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.downloadLimit = Number(new URLSearchParams(body).get('limit')) || 0;
        res.end();
      });
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/api/v2/transfer/setUploadLimit')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.uploadLimit = Number(new URLSearchParams(body).get('limit')) || 0;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihs-tm-bandwidth-test-'));
  const downloadDir = path.join(tmpRoot, 'torrents');
  fs.mkdirSync(downloadDir, { recursive: true });

  fakeQbt = await startFakeQbittorrent();
  const qbtPort = fakeQbt.address().port;

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
  process.env.TORRENT_DOWNLOAD_DIR = downloadDir;
  process.env.APP_PORT = '0';
  process.env.APP_HOST = '127.0.0.1';
  process.env.SESSION_SECRET = 'test-secret-bandwidth-0123456789abcdef';
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
  const admin = shared.Users.create('bw-admin', await shared.hashPassword(adminPw), true);
  const user = shared.Users.create('bw-user', await shared.hashPassword(userPw), false);
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

test('unauthenticated request cannot read bandwidth limits', async () => {
  const res = await fetch(`${baseUrl}/api/admin/bandwidth`);
  assert.equal(res.status, 401);
});

test('a non-admin user cannot read or change bandwidth limits', async () => {
  const session = await login(userCreds);
  const getRes = await fetch(`${baseUrl}/api/admin/bandwidth`, { headers: { Cookie: session.cookie } });
  assert.equal(getRes.status, 403);

  const putRes = await fetch(`${baseUrl}/api/admin/bandwidth`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadLimit: 1024, uploadLimit: 1024 }),
  });
  assert.equal(putRes.status, 403);
});

test('admin can read bandwidth limits', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/bandwidth`, { headers: { Cookie: session.cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.downloadLimit, 'number');
  assert.equal(typeof body.uploadLimit, 'number');
});

test('admin can set bandwidth limits, and the new values round-trip through qBittorrent', async () => {
  const session = await login(adminCreds);
  const putRes = await fetch(`${baseUrl}/api/admin/bandwidth`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadLimit: 512000, uploadLimit: 128000 }),
  });
  assert.equal(putRes.status, 200);

  const getRes = await fetch(`${baseUrl}/api/admin/bandwidth`, { headers: { Cookie: session.cookie } });
  const body = await getRes.json();
  assert.equal(body.downloadLimit, 512000);
  assert.equal(body.uploadLimit, 128000);
});

test('setting limits back to 0 means unlimited and round-trips correctly', async () => {
  const session = await login(adminCreds);
  await fetch(`${baseUrl}/api/admin/bandwidth`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadLimit: 0, uploadLimit: 0 }),
  });
  const getRes = await fetch(`${baseUrl}/api/admin/bandwidth`, { headers: { Cookie: session.cookie } });
  const body = await getRes.json();
  assert.equal(body.downloadLimit, 0);
  assert.equal(body.uploadLimit, 0);
});

test('negative limits are rejected with 400', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/bandwidth`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadLimit: -1, uploadLimit: 0 }),
  });
  assert.equal(res.status, 400);
});

test('missing CSRF token is rejected', async () => {
  const session = await login(adminCreds);
  const res = await fetch(`${baseUrl}/api/admin/bandwidth`, {
    method: 'PUT',
    headers: { Cookie: session.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ downloadLimit: 1000, uploadLimit: 1000 }),
  });
  assert.equal(res.status, 403);
});
