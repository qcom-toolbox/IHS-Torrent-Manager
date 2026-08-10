import * as crypto from 'crypto';
import { getDb } from './db/connection';

export type DownloadTokenIssuer = 'panel' | 'portal';

export interface IssuedDownloadToken {
  /** The raw, unguessable token to embed in the URL. Never stored -- only its hash is. */
  raw: string;
  expiresAt: string;
}

export interface RedeemedDownloadToken {
  torrentId: number;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Opaque, single-purpose download links. A link is minted only after the
 * caller has already verified the requesting user is allowed to download
 * the torrent (ownership / admin / portal auth) -- the token itself then
 * becomes the sole thing the URL reveals, and it expires. Redeeming a
 * token does NOT tell the caller anything about *why* redemption failed
 * (missing vs expired vs wrong owner all look identical from outside).
 */
export const DownloadTokens = {
  issue(
    torrentId: number,
    issuedBy: DownloadTokenIssuer,
    userId: number | null,
    ttlMs: number
  ): IssuedDownloadToken {
    const raw = crypto.randomBytes(32).toString('base64url'); // 256 bits of entropy
    const hash = hashToken(raw);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    getDb()
      .prepare(
        `INSERT INTO download_tokens (token_hash, torrent_id, issued_by, user_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(hash, torrentId, issuedBy, userId, expiresAt);

    // Opportunistic cleanup so the table doesn't grow unbounded; cheap
    // relative to the insert we just did, no separate scheduler needed.
    getDb()
      .prepare(`DELETE FROM download_tokens WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run();

    return { raw, expiresAt };
  },

  /**
   * Validates and consumes one use of a token. Returns null for any
   * failure reason (unknown token, expired token) -- callers must map
   * that to a generic 404, never distinguishing the cases in the response.
   */
  redeem(rawToken: string): RedeemedDownloadToken | null {
    if (!rawToken || rawToken.length > 512) return null;
    const hash = hashToken(rawToken);
    const db = getDb();
    const row = db
      .prepare(`SELECT id, torrent_id, expires_at FROM download_tokens WHERE token_hash = ?`)
      .get(hash) as { id: number; torrent_id: number; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;

    db.prepare(
      `UPDATE download_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), use_count = use_count + 1 WHERE id = ?`
    ).run(row.id);

    return { torrentId: row.torrent_id };
  },
};
