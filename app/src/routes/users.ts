import { Router } from 'express';
import { Users, AuditLog, hashPassword, isPasswordStrongEnough } from '@ihs-torrent-manager/shared';
import { AuthedRequest, requireAuth, requireAdmin } from '../middleware/auth';
import { requireCsrf } from '../middleware/csrf';

const router = Router();
router.use(requireAuth, requireAdmin);

const USERNAME_RE = /^[a-zA-Z0-9_.\-]{3,32}$/;

function serializeUser(u: ReturnType<typeof Users.findById>) {
  if (!u) return null;
  return { id: u.id, username: u.username, isAdmin: !!u.is_admin, createdAt: u.created_at };
}

router.get('/', (_req, res) => {
  res.json({ users: Users.all().map(serializeUser) });
});

router.post('/', requireCsrf, async (req: AuthedRequest, res) => {
  const { username, password, isAdmin } = req.body ?? {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, _ . -' });
    return;
  }
  if (typeof password !== 'string' || !isPasswordStrongEnough(password)) {
    res.status(400).json({ error: 'Password must be between 8 and 512 characters' });
    return;
  }
  if (Users.findByUsername(username)) {
    res.status(409).json({ error: 'Username already exists' });
    return;
  }
  const hash = await hashPassword(password);
  const user = Users.create(username, hash, !!isAdmin);
  AuditLog.record(req.currentUser!.id, 'user_create', 'user', String(user.id), { username, isAdmin: !!isAdmin }, req.ip);
  res.status(201).json({ user: serializeUser(user) });
});

router.put('/:id/password', requireCsrf, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const user = Users.findById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !isPasswordStrongEnough(password)) {
    res.status(400).json({ error: 'Password must be between 8 and 512 characters' });
    return;
  }
  const hash = await hashPassword(password);
  Users.updatePassword(id, hash);
  AuditLog.record(req.currentUser!.id, 'user_password_change', 'user', String(id), undefined, req.ip);
  res.json({ ok: true });
});

router.put('/:id/admin', requireCsrf, (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const user = Users.findById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const { isAdmin } = req.body ?? {};
  if (typeof isAdmin !== 'boolean') {
    res.status(400).json({ error: '"isAdmin" must be a boolean' });
    return;
  }
  if (!isAdmin && user.is_admin && Users.countAdmins() <= 1) {
    res.status(400).json({ error: 'Cannot remove admin rights from the last remaining administrator' });
    return;
  }
  Users.setAdmin(id, isAdmin);
  AuditLog.record(req.currentUser!.id, isAdmin ? 'user_promote' : 'user_demote', 'user', String(id), undefined, req.ip);
  res.json({ ok: true });
});

router.delete('/:id', requireCsrf, (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const user = Users.findById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (id === req.currentUser!.id) {
    res.status(400).json({ error: 'You cannot delete your own account' });
    return;
  }
  if (user.is_admin && Users.countAdmins() <= 1) {
    res.status(400).json({ error: 'Cannot delete the last remaining administrator' });
    return;
  }
  // Deleting a user must never delete their downloaded data: transfer
  // torrent ownership to the admin performing the deletion instead.
  Users.reassignTorrents(id, req.currentUser!.id);
  Users.delete(id);
  AuditLog.record(req.currentUser!.id, 'user_delete', 'user', String(id), { username: user.username }, req.ip);
  res.json({ ok: true });
});

export default router;
