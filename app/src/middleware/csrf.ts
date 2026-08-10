import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function ensureCsrfToken(req: Request, _res: Response, next: NextFunction): void {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  next();
}

/**
 * Double-submit-cookie style CSRF check: the token is stored server-side in
 * the (httpOnly-cookie-addressed) session and must be echoed back in a
 * header. A cross-site request cannot read the token to echo it back.
 */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.get('X-CSRF-Token');
  if (!header || !req.session?.csrfToken || header !== req.session.csrfToken) {
    res.status(403).json({ error: 'Invalid or missing CSRF token' });
    return;
  }
  next();
}
