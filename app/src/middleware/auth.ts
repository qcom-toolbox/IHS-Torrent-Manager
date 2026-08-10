import { Request, Response, NextFunction } from 'express';
import { Users } from '@torrent-manager/shared';

export interface AuthedRequest extends Request {
  currentUser?: { id: number; username: string; isAdmin: boolean };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // Re-verify against the database on every request rather than trusting
  // the session blob -- catches deleted/demoted users immediately.
  const user = Users.findById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.currentUser = { id: user.id, username: user.username, isAdmin: !!user.is_admin };
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.currentUser?.isAdmin) {
    res.status(403).json({ error: 'Administrator privileges required' });
    return;
  }
  next();
}
