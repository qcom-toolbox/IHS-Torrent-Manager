export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
  createdAt?: string;
}

export type TorrentStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'error' | 'missing' | 'stopped';

export interface Torrent {
  id: number;
  hash: string;
  userId: number;
  owner?: string;
  originalFilename: string;
  name: string;
  status: TorrentStatus;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  size: number;
  eta: number | null;
  category: string | null;
  isDir: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DiskInfo {
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  freePercent: number;
  level: 'normal' | 'warning' | 'critical';
  torrentDataBytes: number | null;
  thresholds: { warningPercentFree: number; criticalPercentFree: number; blockPercentFree: number };
}

export interface AdminStats {
  totalUsers: number;
  totalTorrents: number;
  activeTorrents: number;
  completedTorrents: number;
  failedTorrents: number;
  totalStorageUsed: number;
  currentDownloadSpeed: number;
  currentUploadSpeed: number;
}
