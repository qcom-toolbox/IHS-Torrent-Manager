import { Router, Response } from 'express';
import multer from 'multer';
import {
  Torrents,
  TorrentEvents,
  AuditLog,
  Users,
  DownloadTokens,
  StorageLocations,
  resolveStorageRootPath,
  getDiskSpace,
  getDirectorySizeCached,
  getConfiguredDiskThresholds,
  canStartNewDownload,
  isSafeCategory,
  sanitizeFilename,
  isDownloadsEnabled,
  isUploadsEnabled,
} from '@ihs-torrent-manager/shared';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { uploadLimiter } from '../middleware/rateLimit';
import { validateTorrentFile } from '../utils/torrentValidation';
import { qbt } from '../services/qbt';
import { appConfig, shared } from '../config';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: appConfig.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.torrent')) {
      cb(new Error('Only .torrent files are accepted'));
      return;
    }
    cb(null, true);
  },
});

function serializeTorrent(t: ReturnType<typeof Torrents.findById>, ownerUsername?: string) {
  if (!t) return null;
  return {
    id: t.id,
    hash: t.torrent_hash,
    userId: t.user_id,
    owner: ownerUsername,
    // Deliberately no `originalFilename` here: the uploaded .torrent's
    // filename isn't used anywhere in the UI, so it isn't sent over the
    // wire. It still lives in the DB (torrents.original_filename) purely
    // for admin/audit purposes.
    name: t.display_name,
    status: t.status,
    progress: t.progress,
    downloadSpeed: t.download_speed,
    uploadSpeed: t.upload_speed,
    size: t.size,
    eta: t.eta_seconds,
    category: t.category,
    isDir: !!t.is_dir,
    errorMessage: t.error_message,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

function loadOwnedTorrent(req: AuthedRequest, res: Response): ReturnType<typeof Torrents.findById> | null {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid torrent id' });
    return null;
  }
  const torrent = Torrents.findById(id);
  if (!torrent) {
    res.status(404).json({ error: 'Torrent not found' });
    return null;
  }
  if (torrent.user_id !== req.currentUser!.id && !req.currentUser!.isAdmin) {
    // Deliberately identical to the 404 case so a user can't distinguish
    // "doesn't exist" from "exists but isn't yours" by probing IDs.
    res.status(404).json({ error: 'Torrent not found' });
    return null;
  }
  return torrent;
}

router.get('/', (req: AuthedRequest, res) => {
  const torrents = Torrents.allForUser(req.currentUser!.id);
  res.json({ torrents: torrents.map((t) => serializeTorrent(t)) });
});

router.get('/all', (req: AuthedRequest, res) => {
  if (!req.currentUser!.isAdmin) {
    res.status(403).json({ error: 'Administrator privileges required' });
    return;
  }
  const torrents = Torrents.all();
  const users = new Map<number, string>(Users.all().map((u: any) => [u.id, u.username]));
  res.json({ torrents: torrents.map((t) => serializeTorrent(t, users.get(t.user_id))) });
});

// Minimal, non-admin-gated list so any authenticated user can pick a
// destination disk when uploading -- full disk stats/torrent counts stay
// admin-only (see /api/admin/storage-locations for that).
router.get('/storage-locations', (_req: AuthedRequest, res) => {
  const locations = [
    { id: null as number | null, label: 'Default', isDefault: true },
    ...StorageLocations.all().map((loc) => ({ id: loc.id, label: loc.label, isDefault: false })),
  ];
  res.json({ locations });
});

router.get('/disk', async (_req: AuthedRequest, res) => {
  const thresholds = getConfiguredDiskThresholds(shared);
  try {
    const info = await getDiskSpace(shared.torrentDownloadDir, thresholds);
    const torrentDataBytes = await getDirectorySizeCached(shared.torrentDownloadDir);
    res.json({ ...info, torrentDataBytes, thresholds });
  } catch (err: any) {
    res.status(500).json({ error: 'Unable to read disk space information' });
  }
});

router.post('/upload', uploadLimiter, requireCsrf, upload.single('torrent'), async (req: AuthedRequest, res) => {
  if (!isDownloadsEnabled()) {
    res.status(403).json({ error: 'Downloads are currently disabled by the administrator' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'No .torrent file uploaded' });
    return;
  }

  const validation = validateTorrentFile(req.file.buffer);
  if (!validation.valid || !validation.infoHash) {
    res.status(400).json({ error: `Invalid torrent file: ${validation.reason ?? 'unknown error'}` });
    return;
  }

  if (Torrents.findByHash(validation.infoHash)) {
    res.status(409).json({ error: 'This torrent has already been added' });
    return;
  }

  // A storage location is selected by ID from the admin-approved list --
  // the client never supplies a path directly. No ID means the default
  // TORRENT_DOWNLOAD_DIR.
  let storageLocationId: number | null = null;
  const rawLocationId = req.body?.storageLocationId;
  if (rawLocationId !== undefined && rawLocationId !== '' && rawLocationId !== 'default') {
    const parsed = parseInt(String(rawLocationId), 10);
    if (!Number.isInteger(parsed) || !StorageLocations.findById(parsed)) {
      res.status(400).json({ error: 'Unknown storage location' });
      return;
    }
    storageLocationId = parsed;
  }
  const savePath = resolveStorageRootPath(shared.torrentDownloadDir, storageLocationId);

  const thresholds = getConfiguredDiskThresholds(shared);
  try {
    const disk = await getDiskSpace(savePath, thresholds);
    if (!canStartNewDownload(disk.freePercent, thresholds)) {
      res.status(507).json({
        error: `Insufficient free disk space (${disk.freePercent.toFixed(1)}% free). New downloads are blocked below ${thresholds.blockPercentFree}% free.`,
      });
      return;
    }
  } catch {
    // If we can't determine disk space, fail closed with a clear error
    // rather than silently allowing a download that could fill the disk.
    res.status(500).json({ error: 'Unable to verify available disk space; upload rejected' });
    return;
  }

  const safeName = sanitizeFilename(req.file.originalname);
  const rawCategory = typeof req.body?.category === 'string' ? req.body.category : '';
  const category = isSafeCategory(rawCategory) ? rawCategory : '';

  try {
    await qbt.addTorrentFile(req.file.buffer, safeName, {
      savepath: savePath,
      category: category || undefined,
    });
  } catch (err: any) {
    res.status(502).json({ error: `Failed to add torrent to qBittorrent: ${err.message}` });
    return;
  }

  const torrent = Torrents.create({
    torrent_hash: validation.infoHash,
    user_id: req.currentUser!.id,
    original_filename: safeName,
    display_name: validation.name ?? safeName,
    category,
    storage_location_id: storageLocationId,
  });

  TorrentEvents.add(torrent.id, 'created', `Uploaded by ${req.currentUser!.username}`);
  AuditLog.record(req.currentUser!.id, 'torrent_upload', 'torrent', String(torrent.id), {
    filename: safeName,
  }, req.ip);

  res.status(201).json({ torrent: serializeTorrent(torrent) });
});

router.get('/:id', (req: AuthedRequest, res) => {
  const torrent = loadOwnedTorrent(req, res);
  if (!torrent) return;
  const events = TorrentEvents.forTorrent(torrent.id);
  res.json({ torrent: serializeTorrent(torrent), events });
});

router.get('/:id/files', async (req: AuthedRequest, res) => {
  const torrent = loadOwnedTorrent(req, res);
  if (!torrent) return;
  try {
    const files = await qbt.getFiles(torrent.torrent_hash);
    res.json({ files });
  } catch (err: any) {
    res.status(502).json({ error: `Unable to fetch file list: ${err.message}` });
  }
});

async function doAction(
  req: AuthedRequest,
  res: Response,
  action: 'pause' | 'resume' | 'recheck'
) {
  const torrent = loadOwnedTorrent(req, res);
  if (!torrent) return;
  if (action === 'recheck' && !req.currentUser!.isAdmin) {
    res.status(403).json({ error: 'Only administrators can force a recheck' });
    return;
  }
  if (action === 'resume') {
    const wouldSeed = torrent.status === 'completed';
    if (wouldSeed && !isUploadsEnabled()) {
      res.status(403).json({ error: 'Uploading/seeding is currently disabled by the administrator' });
      return;
    }
    if (!wouldSeed && !isDownloadsEnabled()) {
      res.status(403).json({ error: 'Downloads are currently disabled by the administrator' });
      return;
    }
  }
  try {
    await qbt[action]([torrent.torrent_hash]);
    TorrentEvents.add(torrent.id, action, `${action} requested by ${req.currentUser!.username}`);
    AuditLog.record(req.currentUser!.id, `torrent_${action}`, 'torrent', String(torrent.id), undefined, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(502).json({ error: `qBittorrent request failed: ${err.message}` });
  }
}

router.post('/:id/pause', requireCsrf, (req: AuthedRequest, res) => doAction(req, res, 'pause'));
router.post('/:id/resume', requireCsrf, (req: AuthedRequest, res) => doAction(req, res, 'resume'));
// qBittorrent has no separate "stop" concept from "pause" -- exposed as a
// distinct UI action per spec, mapped to the same underlying operation.
router.post('/:id/stop', requireCsrf, (req: AuthedRequest, res) => doAction(req, res, 'pause'));
router.post('/:id/recheck', requireCsrf, (req: AuthedRequest, res) => doAction(req, res, 'recheck'));

router.delete('/:id', requireCsrf, async (req: AuthedRequest, res) => {
  const torrent = loadOwnedTorrent(req, res);
  if (!torrent) return;
  const deleteData = req.query.deleteData === 'true';
  try {
    await qbt.delete([torrent.torrent_hash], deleteData);
  } catch (err: any) {
    // Torrent may already be gone from qBittorrent (e.g. manually removed);
    // proceed to clean up our own record rather than blocking the user.
  }
  Torrents.delete(torrent.id);
  AuditLog.record(req.currentUser!.id, 'torrent_delete', 'torrent', String(torrent.id), {
    deleteData,
  }, req.ip);
  res.json({ ok: true });
});

// Step 1 of the two-step download flow: verify ownership + that the
// torrent is actually completed, then mint a short-lived, unguessable
// token. The actual file transfer happens at GET /api/dl/:token (see
// routes/downloads.ts), which is deliberately its own top-level route so
// the URL used to fetch bytes never contains a torrent id or filename.
router.post('/:id/download-link', requireCsrf, (req: AuthedRequest, res) => {
  const torrent = loadOwnedTorrent(req, res);
  if (!torrent) return;
  if (torrent.status !== 'completed') {
    res.status(409).json({ error: 'Torrent has not finished downloading yet' });
    return;
  }

  const { raw } = DownloadTokens.issue(torrent.id, 'panel', req.currentUser!.id, shared.downloadTokenTtlMs);
  AuditLog.record(req.currentUser!.id, 'torrent_download_link_created', 'torrent', String(torrent.id), undefined, req.ip);
  res.json({ url: `/api/dl/${raw}` });
});

export default router;
