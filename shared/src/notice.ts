import * as fs from 'fs';

const MAX_NOTICE_LENGTH = 4000;

/**
 * Reads the operator-configurable access-warning banner shown on both
 * login pages. Missing file / empty content simply means "don't show a
 * banner" -- this is optional, not a security control.
 */
export function readNoticeText(noticeFilePath: string | undefined): string | null {
  if (!noticeFilePath) return null;
  try {
    const text = fs.readFileSync(noticeFilePath, 'utf-8').trim();
    if (!text) return null;
    return text.slice(0, MAX_NOTICE_LENGTH);
  } catch {
    return null;
  }
}
