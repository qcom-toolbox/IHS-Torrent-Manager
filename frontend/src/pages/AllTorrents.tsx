import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { Torrent, TorrentStatus } from '../types';
import TorrentTable from '../components/TorrentTable';
import ConfirmDialog from '../components/ConfirmDialog';
import { useTorrentActions } from '../lib/useTorrentActions';

type StatusFilter = 'all' | TorrentStatus;

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'downloading', label: 'Downloading' },
  { value: 'queued', label: 'Queued' },
  { value: 'paused', label: 'Paused' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'completed', label: 'Completed' },
  { value: 'error', label: 'Error' },
  { value: 'missing', label: 'Missing' },
];

export default function AllTorrents() {
  const [torrents, setTorrents] = useState<Torrent[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('all');

  const load = useCallback(async () => {
    const res = await api.get<{ torrents: Torrent[] }>('/torrents/all');
    setTorrents(res.torrents);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const { actions, confirmDialog, confirmAction, cancelConfirm } = useTorrentActions(load);

  const counts = useMemo(() => {
    const c = new Map<StatusFilter, number>();
    c.set('all', torrents.length);
    for (const t of torrents) c.set(t.status, (c.get(t.status) ?? 0) + 1);
    return c;
  }, [torrents]);

  const filtered = useMemo(
    () => (filter === 'all' ? torrents : torrents.filter((t) => t.status === filter)),
    [torrents, filter]
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">All Torrents</h1>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {f.label} ({counts.get(f.value) ?? 0})
          </button>
        ))}
      </div>

      <TorrentTable torrents={filtered} actions={actions} showOwner isAdmin />
      <ConfirmDialog options={confirmDialog} onConfirm={confirmAction} onCancel={cancelConfirm} />
    </div>
  );
}
