import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatBytes } from '../lib/format';
import ProgressBar from './ProgressBar';
import type { DiskInfo } from '../types';

const LEVEL_TEXT: Record<DiskInfo['level'], string> = {
  normal: 'Normal',
  warning: 'Warning: disk space is getting low',
  critical: 'Critical: disk space is nearly exhausted',
};

const LEVEL_CLASS: Record<DiskInfo['level'], string> = {
  normal: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  critical: 'text-red-600 dark:text-red-400',
};

export default function DiskSpaceWidget({ detailed = false }: { detailed?: boolean }) {
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await api.get<DiskInfo>('/torrents/disk');
        if (!cancelled) {
          setDisk(d);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div>;
  }
  if (!disk) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900">Loading storage info…</div>;
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Storage</h3>
        <span className={`text-xs font-medium ${LEVEL_CLASS[disk.level]}`}>{LEVEL_TEXT[disk.level]}</span>
      </div>
      <ProgressBar fraction={disk.usedPercent / 100} level={disk.level} />
      <div className="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>Used: {formatBytes(disk.usedBytes)}</span>
        <span>Free: {formatBytes(disk.freeBytes)}</span>
        <span>Total: {formatBytes(disk.totalBytes)}</span>
      </div>
      {detailed && (
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <div>Filesystem: {disk.filesystem}</div>
          <div>Usage: {disk.usedPercent.toFixed(1)}% used / {disk.freePercent.toFixed(1)}% free</div>
          {disk.torrentDataBytes !== null && <div>Torrent data: {formatBytes(disk.torrentDataBytes)}</div>}
        </div>
      )}
    </div>
  );
}
