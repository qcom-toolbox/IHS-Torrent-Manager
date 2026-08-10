import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { runMigrations, getDb, Users, SqliteSessionStore } from '@ihs-torrent-manager/shared';
import { appConfig, shared } from './config';
import { ensureCsrfToken } from './middleware/csrf';
import { apiLimiter } from './middleware/rateLimit';
import authRoutes from './routes/auth';
import torrentRoutes from './routes/torrents';
import downloadRoutes from './routes/downloads';
import userRoutes from './routes/users';
import adminRoutes from './routes/admin';
import { requireAuth } from './middleware/auth';

/**
 * Builds a fully configured Express app but never calls .listen(). Split
 * out from bootstrap() so tests can mount a real instance on an ephemeral
 * port against a temp database, instead of hitting the actual production
 * bootstrap sequence.
 */
export function createApp(): express.Express {
  fs.mkdirSync(appConfig.uploadTmpDir, { recursive: true });

  const applied = runMigrations(shared.databasePath);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} pending migration(s): ${applied.join(', ')}`);
  }

  if (Users.count() === 0) {
    console.warn(
      'WARNING: No users exist yet. Run the admin creation script (scripts/create-admin.js) to create the first administrator.'
    );
  }

  const app = express();
  app.disable('x-powered-by');
  if (appConfig.trustProxy) app.set('trust proxy', 1);

  const cspDirectives: Record<string, Iterable<string> | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  };
  // Helmet includes upgrade-insecure-requests by default. It tells the
  // browser to silently rewrite every subresource request (scripts,
  // stylesheets, fetch/XHR) to https:// before sending it -- great once
  // this is actually served over TLS, but fatal when it isn't: with no
  // HTTPS listener on this port, every asset request fails with
  // ERR_SSL_PROTOCOL_ERROR and the page never renders (confirmed against
  // a real browser: white page on the panel, unstyled login on the
  // portal, form submissions blocked by form-action). Only enable it
  // once COOKIE_SECURE=true, i.e. once there's a real TLS-terminating
  // reverse proxy in front.
  if (!appConfig.cookieSecure) {
    cspDirectives.upgradeInsecureRequests = null;
  }

  app.use(
    helmet({
      contentSecurityPolicy: { directives: cspDirectives },
      // Same reasoning: these only make sense -- and browsers only honor
      // them -- once the origin is actually HTTPS. Sending them over plain
      // HTTP just produces console warnings ("origin was untrustworthy"),
      // so skip them until we know we're behind TLS.
      crossOriginOpenerPolicy: appConfig.cookieSecure ? true : false,
      originAgentCluster: appConfig.cookieSecure ? true : false,
      // HSTS itself is still safe to send unconditionally: browsers only
      // ever act on it once received over a real HTTPS connection, so it
      // never breaks plain-HTTP operation the way the directives above do.
      hsts: { maxAge: 15552000, includeSubDomains: true },
    })
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(
    session({
      name: 'tm.sid',
      secret: appConfig.sessionSecret,
      store: new SqliteSessionStore('panel', 24 * 60 * 60 * 1000),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: appConfig.cookieSecure,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );
  app.use(ensureCsrfToken);
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ ok: true, service: 'ihs-torrent-manager-app' });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/torrents', torrentRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/admin', adminRoutes);
  // Opaque token redemption -- deliberately its own top-level namespace
  // (not nested under /api/torrents/:id/...) so the URL never carries a
  // torrent id or any other identifying information, only the token.
  app.use('/api/dl', requireAuth, downloadRoutes);

  // Serve the built React management panel as static assets, with an SPA
  // fallback so client-side routes (e.g. /users, /torrents/5) work on
  // direct navigation/refresh.
  if (fs.existsSync(appConfig.frontendDistDir)) {
    app.use(express.static(appConfig.frontendDistDir, { index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(appConfig.frontendDistDir, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Centralized error handler: never leak stack traces or internal details.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (err?.message?.includes('File too large')) {
      res.status(413).json({ error: 'Uploaded file exceeds the maximum allowed size' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function bootstrap(): void {
  const app = createApp();
  app.listen(appConfig.port, appConfig.host, () => {
    console.log(`IHS Torrent Manager panel listening on http://${appConfig.host}:${appConfig.port}`);
  });
}

if (require.main === module) {
  bootstrap();
}
