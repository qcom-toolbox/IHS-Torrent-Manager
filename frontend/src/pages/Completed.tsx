import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Torrent } from '../types';
import TorrentTable from '../components/TorrentTable';
import ConfirmDialog from '../components/ConfirmDialog';
import { useTorrentActions } from '../lib/useTorrentActions';

export default function Completed() {
  const [torrents, setTorrents] = useState<Torrent[]>([]);

  const load = useCallback(async () => {
    const res = await api.get<{ torrents: Torrent[] }>('/torrents');
    setTorrents(res.torrents.filter((t) => t.status === 'completed'));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const { actions, confirmDialog, confirmAction, cancelConfirm } = useTorrentActions(load);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Completed</h1>
      <TorrentTable torrents={torrents} actions={actions} />
      <ConfirmDialog options={confirmDialog} onConfirm={confirmAction} onCancel={cancelConfirm} />
    </div>
  );
}
