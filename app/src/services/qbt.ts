import { QbittorrentClient } from '@ihs-torrent-manager/shared';
import { qbtConfig } from '../config';

export const qbt = new QbittorrentClient(
  qbtConfig.torrentHost,
  qbtConfig.torrentUsername,
  qbtConfig.torrentPassword
);
