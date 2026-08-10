#!/usr/bin/env node
/**
 * One-time qBittorrent WebUI credential bootstrap, run by install.sh right
 * after qbittorrent-nox's first start.
 *
 * qBittorrent ships with either a default admin/adminadmin login (older
 * versions) or a randomly generated temporary password printed to its log
 * on first start (4.6+). Rather than reimplementing qBittorrent's own
 * PBKDF2 password hashing to write qBittorrent.conf directly (fragile,
 * version-dependent), this authenticates through the real WebUI API with
 * whatever the initial credentials turn out to be, then uses the API's own
 * setPreferences call to set the permanent username/password and bind
 * address -- qBittorrent hashes it internally, so we never have to.
 *
 * Usage:
 *   node qbt-bootstrap.js <host> <port> <newUsername> <newPassword> <candidatePasswordsFile>
 *
 * candidatePasswordsFile: newline-separated "username:password" pairs to
 * try, in order (e.g. extracted temp password from journalctl, then the
 * admin/adminadmin default).
 */
const http = require('http');
const fs = require('fs');

function req(method, path, { host, port, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const r = http.request(
      { host, port, path, method, headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) } },
      (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
        });
      }
    );
    r.on('error', reject);
    r.setTimeout(10000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function tryLogin(host, port, username, password) {
  const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await req('POST', '/api/v2/auth/login', {
    host,
    port,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `http://${host}:${port}` },
    body,
  });
  if (res.status === 200 && res.body.trim() === 'Ok.' && res.headers['set-cookie']) {
    return res.headers['set-cookie'][0].split(';')[0];
  }
  return null;
}

async function main() {
  const [host, portStr, newUsername, newPassword, candidatesFile] = process.argv.slice(2);
  const port = parseInt(portStr, 10);
  if (!host || !port || !newUsername || !newPassword || !candidatesFile) {
    console.error('Usage: qbt-bootstrap.js <host> <port> <newUsername> <newPassword> <candidatesFile>');
    process.exit(1);
  }

  const candidates = fs
    .readFileSync(candidatesFile, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const idx = l.indexOf(':');
      return { username: l.slice(0, idx), password: l.slice(idx + 1) };
    });

  let cookie = null;
  for (const c of candidates) {
    cookie = await tryLogin(host, port, c.username, c.password);
    if (cookie) {
      console.error(`Authenticated to qBittorrent WebUI as "${c.username}" using an initial/default credential.`);
      break;
    }
  }

  if (!cookie) {
    console.error('Could not authenticate to qBittorrent WebUI with any known initial credential.');
    process.exit(2);
  }

  const prefs = JSON.stringify({
    web_ui_address: '127.0.0.1',
    web_ui_port: port,
    web_ui_username: newUsername,
    web_ui_password: newPassword,
    bypass_local_auth: false,
    web_ui_csrf_protection_enabled: true,
    web_ui_clickjacking_protection_enabled: true,
    web_ui_host_header_validation_enabled: true,
  });

  const setRes = await req('POST', '/api/v2/app/setPreferences', {
    host,
    port,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
      Referer: `http://${host}:${port}`,
    },
    body: `json=${encodeURIComponent(prefs)}`,
  });

  if (setRes.status !== 200) {
    console.error(`Failed to set qBittorrent WebUI preferences: HTTP ${setRes.status} ${setRes.body}`);
    process.exit(3);
  }

  console.error('qBittorrent WebUI credentials and bind address configured.');
  process.exit(0);
}

main().catch((err) => {
  console.error('qbt-bootstrap failed:', err.message);
  process.exit(1);
});
