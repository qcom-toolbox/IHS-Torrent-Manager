import { Link } from 'react-router-dom';
import type { Torrent } from '../types';
import StatusBadge from './StatusBadge';
import ProgressBar from './ProgressBar';
import { formatBytes, formatSpeed, formatDate } from '../lib/format';

export interface TorrentActions {
  onPause: (t: Torrent) => void;
  onResume: (t: Torrent) => void;
  onStop: (t: Torrent) => void;
  onDelete: (t: Torrent) => void;
  onDeleteWithData?: (t: Torrent) => void;
  onRecheck?: (t: Torrent) => void;
  onDownload: (t: Torrent) => void;
}

export default function TorrentTable({
  torrents,
  showOwner,
  isAdmin,
  actions,
}: {
  torrents: Torrent[];
  showOwner?: boolean;
  isAdmin?: boolean;
  actions: TorrentActions;
}) {
  if (torrents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400 dark:border-slate-700">
        No torrents to show.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-800">
        <thead className="bg-slate-50 dark:bg-slate-900">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <th className="px-4 py-3">Name</th>
            {showOwner && <th className="px-4 py-3">Owner</th>}
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 w-40">Progress</th>
            <th className="px-4 py-3">Down</th>
            <th className="px-4 py-3">Up</th>
            <th className="px-4 py-3">Size</th>
            <th className="px-4 py-3">Added</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
          {torrents.map((t) => (
            <tr key={t.id}>
              <td className="max-w-xs truncate px-4 py-3 font-medium text-slate-900 dark:text-slate-100" title={t.name}>
                <Link to={`/torrents/${t.id}`} className="hover:underline">
                  {t.name}
                </Link>
              </td>
              {showOwner && <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{t.owner ?? '—'}</td>}
              <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
              <td className="px-4 py-3">
                <ProgressBar fraction={t.progress} />
                <span className="text-xs text-slate-400">{Math.round(t.progress * 100)}%</span>
              </td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatSpeed(t.downloadSpeed)}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatSpeed(t.uploadSpeed)}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatBytes(t.size)}</td>
              <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{formatDate(t.createdAt)}</td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {t.status === 'paused' || t.status === 'stopped' ? (
                    <button onClick={() => actions.onResume(t)} className="btn-xs">Resume</button>
                  ) : (
                    <button onClick={() => actions.onPause(t)} className="btn-xs">Pause</button>
                  )}
                  <button onClick={() => actions.onStop(t)} className="btn-xs">Stop</button>
                  {t.status === 'completed' && (
                    <button onClick={() => actions.onDownload(t)} className="btn-xs btn-xs-primary">Download</button>
                  )}
                  {isAdmin && actions.onRecheck && (
                    <button onClick={() => actions.onRecheck!(t)} className="btn-xs">Recheck</button>
                  )}
                  <button onClick={() => actions.onDelete(t)} className="btn-xs btn-xs-danger">Delete</button>
                  {isAdmin && actions.onDeleteWithData && (
                    <button onClick={() => actions.onDeleteWithData!(t)} className="btn-xs btn-xs-danger">
                      Delete + Data
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
