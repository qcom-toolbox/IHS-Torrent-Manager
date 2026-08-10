import type { TorrentStatus } from '../types';

const STYLES: Record<TorrentStatus, string> = {
  queued: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  downloading: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200',
  paused: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  stopped: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200',
  error: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200',
  missing: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200',
};

export default function StatusBadge({ status }: { status: TorrentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STYLES[status] ?? STYLES.queued}`}>
      {status}
    </span>
  );
}
