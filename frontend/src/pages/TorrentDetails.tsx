import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Torrent } from '../types';
import StatusBadge from '../components/StatusBadge';
import ProgressBar from '../components/ProgressBar';
import { formatBytes, formatSpeed, formatDate, formatEta } from '../lib/format';
import { useTorrentActions } from '../lib/useTorrentActions';
import ConfirmDialog from '../components/ConfirmDialog';

interface QbtFile {
  name: string;
  size: number;
  progress: number;
}

interface TorrentEvent {
  id: number;
  event_type: string;
  message: string | null;
  created_at: string;
}

export default function TorrentDetails() {
  const { id } = useParams<{ id: string }>();
  const [torrent, setTorrent] = useState<Torrent | null>(null);
  const [events, setEvents] = useState<TorrentEvent[]>([]);
  const [files, setFiles] = useState<QbtFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<{ torrent: Torrent; events: TorrentEvent[] }>(`/torrents/${id}`);
      setTorrent(res.torrent);
      setEvents(res.events);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    api.get<{ files: QbtFile[] }>(`/torrents/${id}/files`).then((res) => setFiles(res.files)).catch(() => setFiles([]));
  }, [id]);

  const { actions, confirmDialog, confirmAction, cancelConfirm } = useTorrentActions(load);

  if (error) return <div className="text-red-600">{error}</div>;
  if (!torrent) return <div className="text-slate-400">Loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/torrents" className="text-sm text-blue-600 hover:underline dark:text-blue-400">← Back to My Torrents</Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">{torrent.name}</h1>
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-3">
          <StatusBadge status={torrent.status} />
          {torrent.errorMessage && <span className="text-sm text-red-600 dark:text-red-400">{torrent.errorMessage}</span>}
        </div>
        <ProgressBar fraction={torrent.progress} />
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div><div className="text-slate-400">Size</div><div className="font-medium">{formatBytes(torrent.size)}</div></div>
          <div><div className="text-slate-400">Download</div><div className="font-medium">{formatSpeed(torrent.downloadSpeed)}</div></div>
          <div><div className="text-slate-400">Upload</div><div className="font-medium">{formatSpeed(torrent.uploadSpeed)}</div></div>
          <div><div className="text-slate-400">ETA</div><div className="font-medium">{formatEta(torrent.eta)}</div></div>
          <div><div className="text-slate-400">Added</div><div className="font-medium">{formatDate(torrent.createdAt)}</div></div>
          <div><div className="text-slate-400">Completed</div><div className="font-medium">{formatDate(torrent.completedAt)}</div></div>
          <div><div className="text-slate-400">Category</div><div className="font-medium">{torrent.category || '—'}</div></div>
          <div><div className="text-slate-400">Hash</div><div className="font-mono text-xs">{torrent.hash}</div></div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {torrent.status === 'paused' || torrent.status === 'stopped' ? (
            <button onClick={() => actions.onResume(torrent)} className="btn-xs">Resume</button>
          ) : (
            <button onClick={() => actions.onPause(torrent)} className="btn-xs">Pause</button>
          )}
          <button onClick={() => actions.onStop(torrent)} className="btn-xs">Stop</button>
          {torrent.status === 'completed' && (
            <button onClick={() => actions.onDownload(torrent)} className="btn-xs btn-xs-primary">Download</button>
          )}
          <button onClick={() => actions.onDelete(torrent)} className="btn-xs btn-xs-danger">Delete</button>
        </div>
      </div>

      <div className="card">
        <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Files</h2>
        {files === null ? (
          <div className="text-sm text-slate-400">Loading files…</div>
        ) : files.length === 0 ? (
          <div className="text-sm text-slate-400">No file information available.</div>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between py-2">
                <span className="truncate">{f.name}</span>
                <span className="ml-4 flex-shrink-0 text-slate-400">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent activity</h2>
        {events.length === 0 ? (
          <div className="text-sm text-slate-400">No events recorded yet.</div>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2">
                <span className="capitalize">{e.event_type}{e.message ? `: ${e.message}` : ''}</span>
                <span className="ml-4 flex-shrink-0 text-slate-400">{formatDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog options={confirmDialog} onConfirm={confirmAction} onCancel={cancelConfirm} />
    </div>
  );
}
