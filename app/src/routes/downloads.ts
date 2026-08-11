import { Router } from 'express';
import archiver from 'archiver';
import * as fs from 'fs';
import rateLimit from 'express-rate-limit';
import {
  Torrents,
  AuditLog,
  DownloadTokens,
  resolveTorrentContentPaths,
  resolveStorageRootPath,
  genericDownloadFilename,
} from '@ihs-torrent-manager/shared';
import { AuthedRequest } from '../middleware/auth';
import { qbt } from '../services/qbt';
import { shared } from '../config';

const router = Router();

// Redeeming a link has no legitimate reason to happen at high frequency;
// this doubles as brute-force/enumeration protection on top of the
// tokens' 256 bits of entropy.
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(downloadLimiter);

// The URL here is /api/dl/<token> -- deliberately mounted outside
// /api/torrents so it never carries a torrent id, let alone a filename.
// This route is itself behind requireAuth (applied where it's mounted in
// index.ts): a leaked link alone is not enough to redeem it, the redeemer
// also needs a valid session for a user who was the original owner/admin
// at the time of redemption.
router.get('/:token', async (req: AuthedRequest, res) => {
  const redeemed = DownloadTokens.redeem(req.params.token);
  // Every failure path below returns the identical 404 -- unknown token,
  // expired token, torrent gone, wrong owner, not completed -- none of
  // them are distinguishable from outside.
  if (!redeemed) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const torrent = Torrents.findById(redeemed.torrentId);
  if (!torrent) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (torrent.user_id !== req.currentUser!.id && !req.currentUser!.isAdmin) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (torrent.status !== 'completed' || !torrent.save_path) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    // A torrent's files are confined to whichever storage location it was
    // added under -- never blindly the default directory, so a torrent
    // saved on a second disk can't have its containment check bypassed by
    // resolving against the wrong (unrelated) base directory.
    let storageRoot: string;
    try {
      storageRoot = resolveStorageRootPath(shared.torrentDownloadDir, torrent.storage_location_id);
    } catch {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const qbtFiles = await qbt.getFiles(torrent.torrent_hash);
    const resolved = resolveTorrentContentPaths(storageRoot, torrent.save_path, qbtFiles);
    if (resolved.length === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    AuditLog.record(req.currentUser!.id, 'torrent_download', 'torrent', String(torrent.id), undefined, req.ip);

    if (resolved.length === 1) {
      const f = resolved[0];
      if (!fs.existsSync(f.absPath)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.download(f.absPath, genericDownloadFilename(f.relName, 'file'));
      return;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${genericDownloadFilename('', 'archive')}"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => {
      res.status(500).end('Archive error');
    });
    archive.pipe(res);
    for (const f of resolved) {
      if (fs.existsSync(f.absPath)) {
        archive.file(f.absPath, { name: f.relName });
      }
    }
    await archive.finalize();
  } catch {
    res.status(502).json({ error: 'Download failed' });
  }
});

export default router;
