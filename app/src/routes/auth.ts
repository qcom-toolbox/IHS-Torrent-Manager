import { Router } from 'express';
import { Users, AuditLog, LoginAttempts, verifyPassword, hashPassword, isPasswordStrongEnough, readNoticeText } from '@torrent-manager/shared';
import { loginLimiter } from '../middleware/rateLimit';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';
import { shared } from '../config';

const router = Router();

const MAX_RECENT_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// Public (unauthenticated) -- the access-warning banner needs to be visible
// on the login page itself, before anyone has a session.
router.get('/notice', (_req, res) => {
  res.json({ notice: readNoticeText(shared.noticeFilePath) });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const identifier = username.toLowerCase();
  const recentFailures = LoginAttempts.recentFailures(identifier, 'panel', FAILURE_WINDOW_MS);
  if (recentFailures >= MAX_RECENT_FAILURES) {
    res.status(429).json({ error: 'Too many failed login attempts. Please try again later.' });
    return;
  }

  const user = Users.findByUsername(username);
  const ok = user ? await verifyPassword(user.password_hash, password) : false;

  LoginAttempts.record(identifier, 'panel', ok, req.ip);

  if (!user || !ok) {
    AuditLog.record(null, 'login_failed', 'user', username, undefined, req.ip);
    // Same generic message whether the username or password was wrong.
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: 'Login failed' });
      return;
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = !!user.is_admin;
    AuditLog.record(user.id, 'login_success', 'user', String(user.id), undefined, req.ip);
    req.session.save(() => {
      res.json({
        user: { id: user.id, username: user.username, isAdmin: !!user.is_admin },
        csrfToken: req.session.csrfToken,
      });
    });
  });
});

router.post('/logout', requireAuth, (req: AuthedRequest, res) => {
  const userId = req.currentUser?.id ?? null;
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    if (userId) AuditLog.record(userId, 'logout', 'user', String(userId));
    res.clearCookie('tm.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req: AuthedRequest, res) => {
  if (!req.session?.userId) {
    res.json({ user: null, csrfToken: req.session?.csrfToken });
    return;
  }
  const user = Users.findById(req.session.userId);
  if (!user) {
    res.json({ user: null, csrfToken: req.session?.csrfToken });
    return;
  }
  res.json({
    user: { id: user.id, username: user.username, isAdmin: !!user.is_admin },
    csrfToken: req.session.csrfToken,
  });
});

router.put('/password', requireAuth, requireCsrf, async (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'Current and new password are required' });
    return;
  }
  if (!isPasswordStrongEnough(newPassword)) {
    res.status(400).json({ error: 'New password must be between 8 and 512 characters' });
    return;
  }
  const user = Users.findById(req.currentUser!.id)!;
  const ok = await verifyPassword(user.password_hash, currentPassword);
  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  const hash = await hashPassword(newPassword);
  Users.updatePassword(user.id, hash);
  AuditLog.record(user.id, 'self_password_change', 'user', String(user.id), undefined, req.ip);
  res.json({ ok: true });
});

export default router;
