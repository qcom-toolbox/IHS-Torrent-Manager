import { Router } from 'express';
import {
  Users,
  Torrents,
  Settings,
  AuditLog,
  hashPassword,
  isPasswordStrongEnough,
  TRANSFER_POLICY_KEYS,
  getTransferPolicy,
} from '@ihs-torrent-manager/shared';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { qbt } from '../services/qbt';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', (_req, res) => {
  const torrents = Torrents.all();
  const active = torrents.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
  const completed = torrents.filter((t) => t.status === 'completed').length;
  const failed = torrents.filter((t) => t.status === 'error' || t.status === 'missing').length;
  const currentDownloadSpeed = torrents.reduce((sum, t) => sum + (t.download_speed || 0), 0);
  const currentUploadSpeed = torrents.reduce((sum, t) => sum + (t.upload_speed || 0), 0);
  const totalStorageUsed = torrents
    .filter((t) => t.status === 'completed')
    .reduce((sum, t) => sum + (t.size || 0), 0);

  res.json({
    totalUsers: Users.count(),
    totalTorrents: torrents.length,
    activeTorrents: active,
    completedTorrents: completed,
    failedTorrents: failed,
    totalStorageUsed,
    currentDownloadSpeed,
    currentUploadSpeed,
  });
});

router.get('/audit-log', (_req, res) => {
  res.json({ entries: AuditLog.recent(200) });
});

router.get('/settings', (_req, res) => {
  res.json({ settings: Settings.all() });
});

const ALLOWED_SETTINGS = new Set([
  'disk_warning_percent_free',
  'disk_critical_percent_free',
  'disk_block_percent_free',
]);

router.put('/settings', requireCsrf, (req: AuthedRequest, res) => {
  const updates = req.body ?? {};
  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_SETTINGS.has(key)) {
      res.status(400).json({ error: `Unknown or non-configurable setting: ${key}` });
      return;
    }
    const num = parseInt(String(value), 10);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
      res.status(400).json({ error: `Setting ${key} must be a percentage between 0 and 100` });
      return;
    }
    Settings.set(key, String(num));
  }
  AuditLog.record(req.currentUser!.id, 'settings_update', 'settings', undefined, updates, req.ip);
  res.json({ ok: true, settings: Settings.all() });
});

router.put('/portal-password', requireCsrf, async (req: AuthedRequest, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !isPasswordStrongEnough(password)) {
    res.status(400).json({ error: 'Password must be between 8 and 512 characters' });
    return;
  }
  const hash = await hashPassword(password);
  Settings.set('portal_password_hash', hash);
  AuditLog.record(req.currentUser!.id, 'portal_password_change', 'settings', undefined, undefined, req.ip);
  res.json({ ok: true });
});

// Global (not per-torrent) upload/download speed limits, delegated
// entirely to qBittorrent's own rate limiter via its Web API -- the app
// doesn't implement any throttling itself. Values are bytes/sec; 0 means
// unlimited (matches qBittorrent's own convention).
router.get('/bandwidth', async (_req, res) => {
  try {
    const limits = await qbt.getSpeedLimits();
    res.json(limits);
  } catch {
    res.status(502).json({ error: 'Unable to fetch bandwidth limits from qBittorrent' });
  }
});

router.put('/bandwidth', requireCsrf, async (req: AuthedRequest, res) => {
  const { downloadLimit, uploadLimit } = req.body ?? {};
  const dl = Number(downloadLimit);
  const ul = Number(uploadLimit);
  if (!Number.isFinite(dl) || dl < 0 || !Number.isFinite(ul) || ul < 0) {
    res.status(400).json({
      error: 'downloadLimit and uploadLimit must be non-negative numbers (bytes/sec, 0 = unlimited)',
    });
    return;
  }

  try {
    await qbt.setSpeedLimits(dl, ul);
  } catch {
    res.status(502).json({ error: 'Unable to update bandwidth limits on qBittorrent' });
    return;
  }

  AuditLog.record(
    req.currentUser!.id,
    'bandwidth_limits_update',
    'settings',
    undefined,
    { downloadLimit: dl, uploadLimit: ul },
    req.ip
  );
  res.json({ ok: true, downloadLimit: dl, uploadLimit: ul });
});

// Master on/off switches for downloading and uploading/seeding, distinct
// from the rate limits above (0 there means "unlimited", so it can't
// double as "off"). Turning a switch off immediately pauses every
// matching torrent right now; the worker (see worker/src/index.ts) keeps
// enforcing it afterward (re-pausing anything that would otherwise start
// downloading/seeding), and the upload and resume routes refuse to start
// anything new while disabled. Turning a switch back on only lifts the
// block -- it does not auto-resume torrents a user paused themselves.
router.get('/transfer-policy', (_req, res) => {
  res.json(getTransferPolicy());
});

router.put('/transfer-policy', requireCsrf, async (req: AuthedRequest, res) => {
  const { downloadsEnabled, uploadsEnabled } = req.body ?? {};
  if (downloadsEnabled === undefined && uploadsEnabled === undefined) {
    res.status(400).json({ error: 'Provide downloadsEnabled and/or uploadsEnabled (boolean)' });
    return;
  }
  if (downloadsEnabled !== undefined && typeof downloadsEnabled !== 'boolean') {
    res.status(400).json({ error: 'downloadsEnabled must be a boolean' });
    return;
  }
  if (uploadsEnabled !== undefined && typeof uploadsEnabled !== 'boolean') {
    res.status(400).json({ error: 'uploadsEnabled must be a boolean' });
    return;
  }

  const hashesToPause: string[] = [];

  if (downloadsEnabled === false) {
    Settings.set(TRANSFER_POLICY_KEYS.downloadsEnabled, 'false');
    for (const t of Torrents.all()) {
      if (t.status === 'downloading' || t.status === 'queued') hashesToPause.push(t.torrent_hash);
    }
  } else if (downloadsEnabled === true) {
    Settings.set(TRANSFER_POLICY_KEYS.downloadsEnabled, 'true');
  }

  if (uploadsEnabled === false) {
    Settings.set(TRANSFER_POLICY_KEYS.uploadsEnabled, 'false');
    for (const t of Torrents.all()) {
      if (t.status === 'completed') hashesToPause.push(t.torrent_hash);
    }
  } else if (uploadsEnabled === true) {
    Settings.set(TRANSFER_POLICY_KEYS.uploadsEnabled, 'true');
  }

  if (hashesToPause.length > 0) {
    try {
      await qbt.pause(hashesToPause);
    } catch {
      res.status(502).json({ error: 'Updated the policy, but failed to pause matching torrents on qBittorrent' });
      return;
    }
  }

  AuditLog.record(
    req.currentUser!.id,
    'transfer_policy_update',
    'settings',
    undefined,
    { downloadsEnabled, uploadsEnabled },
    req.ip
  );
  res.json(getTransferPolicy());
});

export default router;
