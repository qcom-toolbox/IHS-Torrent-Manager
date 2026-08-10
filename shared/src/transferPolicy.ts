import { Settings } from './db/models';

export const TRANSFER_POLICY_KEYS = {
  downloadsEnabled: 'downloads_enabled',
  uploadsEnabled: 'uploads_enabled',
} as const;

/** Downloading is enabled unless an admin has explicitly turned it off. */
export function isDownloadsEnabled(): boolean {
  return Settings.get(TRANSFER_POLICY_KEYS.downloadsEnabled) !== 'false';
}

/** Uploading/seeding is enabled unless an admin has explicitly turned it off. */
export function isUploadsEnabled(): boolean {
  return Settings.get(TRANSFER_POLICY_KEYS.uploadsEnabled) !== 'false';
}

export function getTransferPolicy(): { downloadsEnabled: boolean; uploadsEnabled: boolean } {
  return { downloadsEnabled: isDownloadsEnabled(), uploadsEnabled: isUploadsEnabled() };
}
