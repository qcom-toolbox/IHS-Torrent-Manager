import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import type { Torrent, AdminStats } from '../types';
import { formatBytes, formatSpeed } from '../lib/format';
import DiskSpaceWidget from '../components/DiskSpaceWidget';

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await api.get<{ torrents: Torrent[] }>('/torrents');
      if (!cancelled) setTorrents(res.torrents);
      if (user?.isAdmin) {
        const stats = await api.get<AdminStats>('/admin/stats');
        if (!cancelled) setAdminStats(stats);
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user?.isAdmin]);

  const active = torrents.filter((t) => t.status === 'downloading' || t.status === 'queued').length;
  const completed = torrents.filter((t) => t.status === 'completed').length;
  const totalDownloaded = torrents.filter((t) => t.status === 'completed').reduce((s, t) => s + t.size, 0);
  const currentSpeed = torrents.reduce((s, t) => s + t.downloadSpeed, 0);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Dashboard</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Active Torrents" value={String(active)} />
        <StatCard label="Completed Torrents" value={String(completed)} />
        <StatCard label="Total Downloaded" value={formatBytes(totalDownloaded)} />
        <StatCard label="Current Download Speed" value={formatSpeed(currentSpeed)} />
      </div>

      <DiskSpaceWidget />

      {user?.isAdmin && adminStats && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Administration</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard label="Total Users" value={String(adminStats.totalUsers)} />
            <StatCard label="Active Torrents (all)" value={String(adminStats.activeTorrents)} />
            <StatCard label="Completed (all)" value={String(adminStats.completedTorrents)} />
            <StatCard label="Failed Torrents" value={String(adminStats.failedTorrents)} />
            <StatCard label="Total Storage Used" value={formatBytes(adminStats.totalStorageUsed)} />
            <StatCard label="Download Activity" value={formatSpeed(adminStats.currentDownloadSpeed)} />
            <StatCard label="Upload Activity" value={formatSpeed(adminStats.currentUploadSpeed)} />
            <StatCard label="Total Torrents" value={String(adminStats.totalTorrents)} />
          </div>
        </div>
      )}
    </div>
  );
}
