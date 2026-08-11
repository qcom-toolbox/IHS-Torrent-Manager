import { Router } from 'express';
import * as path from 'path';
import {
  Users,
  Torrents,
  Settings,
  AuditLog,
  hashPassword,
  isPasswordStrongEnough,
  TRANSFER_POLICY_KEYS,
  getTransferPolicy,
  StorageLocations,
  checkStorageLocationWritable,
  getDiskSpace,
  getDirectorySizeCached,
  getConfiguredDiskThresholds,
} from '@ihs-torrent-manager/shared';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { qbt } from '../services/qbt';
import { shared } from '../config';

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
  } catch (err: any) {
    console.error('[admin] failed to fetch bandwidth limits from qBittorrent:', err);
    res.status(502).json({ error: `Unable to fetch bandwidth limits from qBittorrent: ${err.message}` });
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
  } catch (err: any) {
    console.error('[admin] failed to set bandwidth limits on qBittorrent:', err);
    res.status(502).json({ error: `Unable to update bandwidth limits on qBittorrent: ${err.message}` });
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
    } catch (err: any) {
      console.error('[admin] transfer-policy: failed to pause matching torrents on qBittorrent:', err);
      res
        .status(502)
        .json({ error: `Updated the policy, but failed to pause matching torrents on qBittorrent: ${err.message}` });
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

// Additional storage locations (extra disks/mount points) beyond the
// default TORRENT_DOWNLOAD_DIR. Every path here is admin-approved and
// stored server-side; uploads reference one by ID, never by a client-
// supplied path (see routes/torrents.ts). Adding one only registers it in
// the database -- if the path is on a disk the systemd sandbox doesn't
// already have write access to (ReadWritePaths=), the writability check
// below fails with the exact remediation command
// (scripts/add-storage-path.sh), which handles the systemd side and then
// registers it the same way.
router.get('/storage-locations', async (_req, res) => {
  const thresholds = getConfiguredDiskThresholds(shared);

  async function describeLocation(id: number | null, label: string, dirPath: string, isDefault: boolean) {
    const torrentCount = id === null
      ? Torrents.all().filter((t) => t.storage_location_id === null).length
      : StorageLocations.countTorrentsUsing(id);
    let disk = null;
    try {
      const info = await getDiskSpace(dirPath, thresholds);
      const torrentDataBytes = await getDirectorySizeCached(dirPath);
      disk = { ...info, torrentDataBytes };
    } catch {
      // Path might be temporarily unreachable (unmounted disk, etc.) --
      // still list the location, just without live disk stats.
    }
    return { id, label, path: dirPath, isDefault, torrentCount, disk };
  }

  const results = [
    await describeLocation(null, 'Default', shared.torrentDownloadDir, true),
    ...(await Promise.all(
      StorageLocations.all().map((loc) => describeLocation(loc.id, loc.label, loc.path, false))
    )),
  ];
  res.json({ locations: results });
});

router.post('/storage-locations', requireCsrf, (req: AuthedRequest, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const rawPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';

  if (!label || label.length > 100) {
    res.status(400).json({ error: 'Label is required (max 100 characters)' });
    return;
  }
  if (!rawPath) {
    res.status(400).json({ error: 'Path is required' });
    return;
  }
  if (!path.isAbsolute(rawPath)) {
    res.status(400).json({ error: 'Path must be absolute (e.g. /mnt/disk2/torrents)' });
    return;
  }
  const absolutePath = path.resolve(rawPath);
  if (absolutePath === shared.torrentDownloadDir) {
    res.status(400).json({ error: 'This is already the default storage location' });
    return;
  }
  if (StorageLocations.findByPath(absolutePath)) {
    res.status(409).json({ error: 'This path is already registered as a storage location' });
    return;
  }

  const check = checkStorageLocationWritable(absolutePath);
  if (!check.ok) {
    res.status(400).json({ error: check.reason });
    return;
  }

  const location = StorageLocations.create(label, absolutePath);
  AuditLog.record(req.currentUser!.id, 'storage_location_add', 'storage_location', String(location.id), {
    label,
    path: absolutePath,
  }, req.ip);
  res.status(201).json({ location });
});

router.delete('/storage-locations/:id', requireCsrf, (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const location = Number.isInteger(id) ? StorageLocations.findById(id) : undefined;
  if (!location) {
    res.status(404).json({ error: 'Storage location not found' });
    return;
  }
  const inUse = StorageLocations.countTorrentsUsing(id);
  if (inUse > 0) {
    res.status(409).json({
      error: `${inUse} torrent(s) still use this storage location. Delete or move them first -- the files on disk are never touched by removing a storage location entry itself.`,
    });
    return;
  }
  StorageLocations.delete(id);
  AuditLog.record(req.currentUser!.id, 'storage_location_remove', 'storage_location', String(id), {
    label: location.label,
    path: location.path,
  }, req.ip);
  res.json({ ok: true });
});

export default router;
