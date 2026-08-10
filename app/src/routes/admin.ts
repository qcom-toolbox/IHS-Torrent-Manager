import { Router } from 'express';
import { Users, Torrents, Settings, AuditLog, hashPassword, isPasswordStrongEnough } from '@torrent-manager/shared';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';

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

export default router;
