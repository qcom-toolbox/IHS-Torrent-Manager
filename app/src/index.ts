import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import * as fs from 'fs';
import * as path from 'path';
import { runMigrations, getDb, Users, SqliteSessionStore } from '@torrent-manager/shared';
import { appConfig, shared } from './config';
import { ensureCsrfToken } from './middleware/csrf';
import { apiLimiter } from './middleware/rateLimit';
import authRoutes from './routes/auth';
import torrentRoutes from './routes/torrents';
import userRoutes from './routes/users';
import adminRoutes from './routes/admin';

function bootstrap() {
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

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
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
      res.json({ ok: true, service: 'torrent-manager-app' });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/torrents', torrentRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/admin', adminRoutes);

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

  app.listen(appConfig.port, appConfig.host, () => {
    console.log(`Torrent Manager panel listening on http://${appConfig.host}:${appConfig.port}`);
  });
}

bootstrap();
