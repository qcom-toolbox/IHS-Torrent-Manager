import express, { Express, Request, Response, NextFunction } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import archiver from 'archiver';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import {
  runMigrations,
  getDb,
  Torrents,
  Settings,
  LoginAttempts,
  AuditLog,
  verifyPassword,
  SqliteSessionStore,
  resolveContentRoot,
  listFilesRecursively,
  genericDownloadFilename,
  DownloadTokens,
  readNoticeText,
} from '@ihs-torrent-manager/shared';
import { portalConfig, shared } from './config';

const MAX_RECENT_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_IDENTIFIER = 'portal';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toISOString().slice(0, 10);
}

function requirePortalAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.authenticated) {
    next();
    return;
  }
  res.redirect('/login');
}

function ensureCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  next();
}

function checkCsrf(req: Request, res: Response, next: NextFunction): void {
  const token = req.body?._csrf;
  if (!token || !req.session?.csrfToken || token !== req.session.csrfToken) {
    res.status(403).send('Invalid session, please reload the page and try again.');
    return;
  }
  next();
}

/**
 * Loads the on-disk file list for a completed torrent, purely from the
 * download directory + display name (no qBittorrent access -- see
 * shared/src/services/torrentFiles.ts). Returns null on any failure
 * (missing torrent, not completed, nothing on disk) so callers can
 * respond with a single generic "not found" regardless of which case hit.
 */
function loadCompletedTorrentFiles(torrentId: number) {
  const torrent = Torrents.findById(torrentId);
  if (!torrent || torrent.status !== 'completed') return null;
  try {
    const root = resolveContentRoot(shared.torrentDownloadDir, torrent.display_name);
    if (!fs.existsSync(root)) return null;
    const files = listFilesRecursively(shared.torrentDownloadDir, root);
    if (files.length === 0) return null;
    return { torrent, files };
  } catch {
    return null;
  }
}

/** Builds a fully configured Express app but never calls .listen(). */
export function createApp(): Express {
  runMigrations(shared.databasePath);

  const app = express();
  app.disable('x-powered-by');
  if (portalConfig.trustProxy) app.set('trust proxy', 1);

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 15552000, includeSubDomains: true },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(
    session({
      name: 'portal.sid',
      secret: portalConfig.sessionSecret,
      store: new SqliteSessionStore('portal', 12 * 60 * 60 * 1000),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: portalConfig.cookieSecure,
        sameSite: 'lax',
        maxAge: 12 * 60 * 60 * 1000,
      },
    })
  );
  app.use(ensureCsrf);
  // Available to every EJS template as `notice` without threading it
  // through each individual res.render() call.
  app.use((_req, res, next) => {
    res.locals.notice = readNoticeText(shared.noticeFilePath);
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Deliberately tight: redeeming download links has no legitimate reason
  // to happen at high frequency, so this doubles as brute-force/enumeration
  // protection on top of the tokens' 256 bits of entropy.
  const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'ihs-torrent-manager-portal' });
  });

  app.get('/login', (req, res) => {
    if (req.session?.authenticated) {
      res.redirect('/');
      return;
    }
    res.render('login', { error: null, csrfToken: req.session!.csrfToken });
  });

  app.post('/login', loginLimiter, checkCsrf, async (req, res) => {
    const failures = LoginAttempts.recentFailures(PORTAL_IDENTIFIER, 'portal', FAILURE_WINDOW_MS);
    if (failures >= MAX_RECENT_FAILURES) {
      res.status(429).render('login', {
        error: 'Too many failed attempts. Please try again later.',
        csrfToken: req.session!.csrfToken,
      });
      return;
    }

    const hash = Settings.get('portal_password_hash');
    const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
    const ok = hash ? await verifyPassword(hash, submitted) : false;

    LoginAttempts.record(PORTAL_IDENTIFIER, 'portal', ok, req.ip);

    if (!ok) {
      res.status(401).render('login', {
        error: hash ? 'Incorrect password.' : 'The download portal has not been configured yet.',
        csrfToken: req.session!.csrfToken,
      });
      return;
    }

    req.session.regenerate((err) => {
      if (err) {
        res.status(500).render('login', { error: 'Login failed, please try again.', csrfToken: req.session?.csrfToken });
        return;
      }
      req.session.authenticated = true;
      req.session.save(() => res.redirect('/'));
    });
  });

  app.post('/logout', checkCsrf, (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('portal.sid');
      res.redirect('/login');
    });
  });

  app.get('/', requirePortalAuth, (req, res) => {
    const completed = Torrents.allCompleted().map((t) => ({
      id: t.id,
      name: t.display_name,
      sizeFormatted: formatBytes(t.size),
      completedAtFormatted: formatDate(t.completed_at),
    }));
    res.render('downloads', { torrents: completed, csrfToken: req.session!.csrfToken });
  });

  // Step 1: mint an opaque, short-lived token for a specific completed
  // torrent. Requires an active portal session (the "authenticated route
  // that verifies permissions" this whole design is built around) and a
  // valid CSRF token, exactly like every other state-changing portal route.
  app.post('/create-download-link/:id', requirePortalAuth, checkCsrf, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || !loadCompletedTorrentFiles(id)) {
      res.status(404).send('Not found');
      return;
    }
    const { raw } = DownloadTokens.issue(id, 'portal', null, shared.downloadTokenTtlMs);
    AuditLog.record(null, 'portal_download_link_created', 'torrent', String(id), undefined, req.ip);
    res.redirect(`/dl/${raw}`);
  });

  // Step 2: redeem the token. The URL contains nothing but the token --
  // no torrent id, no filename, no extension hints beyond what's strictly
  // needed for the browser to save the file usably.
  app.get('/dl/:token', requirePortalAuth, downloadLimiter, (req, res) => {
    const redeemed = DownloadTokens.redeem(req.params.token);
    // Same response whether the token is unknown, expired, or (below)
    // the torrent it pointed to is no longer downloadable -- redemption
    // failures never reveal which case occurred.
    if (!redeemed) {
      res.status(404).send('Not found');
      return;
    }
    const loaded = loadCompletedTorrentFiles(redeemed.torrentId);
    if (!loaded) {
      res.status(404).send('Not found');
      return;
    }
    const { torrent, files } = loaded;

    AuditLog.record(null, 'portal_download', 'torrent', String(torrent.id), undefined, req.ip);

    if (files.length === 1) {
      const f = files[0];
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
    for (const f of files) {
      archive.file(f.absPath, { name: f.relName });
    }
    archive.finalize();
  });

  // Anything else -- explicitly not found. This app intentionally has no
  // other routes: no API, no file browser, no config exposure.
  app.use((_req, res) => {
    res.status(404).send('Not found');
  });

  return app;
}

function bootstrap(): void {
  const app = createApp();
  app.listen(portalConfig.port, portalConfig.host, () => {
    console.log(`Download portal listening on http://${portalConfig.host}:${portalConfig.port}`);
  });
}

if (require.main === module) {
  process.on('SIGTERM', () => {
    getDb().close();
    process.exit(0);
  });
  bootstrap();
}
