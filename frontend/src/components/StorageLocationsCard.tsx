import { useEffect, useState, useCallback } from 'react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import { formatBytes } from '../lib/format';
import ProgressBar from './ProgressBar';
import ConfirmDialog, { ConfirmOptions } from './ConfirmDialog';

interface StorageLocation {
  id: number | null;
  label: string;
  path: string;
  isDefault: boolean;
  torrentCount: number;
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
    freePercent: number;
    level: 'normal' | 'warning' | 'critical';
    torrentDataBytes: number | null;
  } | null;
}

export default function StorageLocationsCard() {
  const { notify } = useToast();
  const [locations, setLocations] = useState<StorageLocation[] | null>(null);
  const [label, setLabel] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ options: ConfirmOptions; run: () => Promise<void> } | null>(null);

  const load = useCallback(() => {
    api
      .get<{ locations: StorageLocation[] }>('/admin/storage-locations')
      .then((res) => setLocations(res.locations))
      .catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    try {
      await api.post('/admin/storage-locations', { label, path: pathInput });
      notify(`Storage location "${label}" added`, 'success');
      setLabel('');
      setPathInput('');
      load();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Failed to add storage location');
    } finally {
      setAdding(false);
    }
  }

  function handleDelete(loc: StorageLocation) {
    setConfirm({
      options: {
        title: 'Remove storage location',
        message: `Remove "${loc.label}" (${loc.path}) from the list? This only removes the entry -- files already on that disk are never touched.`,
        confirmLabel: 'Remove',
        danger: true,
      },
      run: async () => {
        try {
          await api.del(`/admin/storage-locations/${loc.id}`);
          notify(`Removed "${loc.label}"`, 'success');
          load();
        } catch (err) {
          notify(err instanceof ApiError ? err.message : 'Failed to remove storage location', 'error');
        }
      },
    });
  }

  return (
    <div className="card max-w-lg">
      <h2 className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">Storage locations</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Additional disks/mount points torrents can be saved to, alongside the default download directory. Users pick
        one when uploading. Adding a location here only registers it -- if the path is on a disk the service doesn't
        already have write access to, you'll get an exact command to run on the server.
      </p>

      {locations === null && <div className="text-sm text-slate-400">Loading…</div>}

      {locations && (
        <ul className="mb-4 flex flex-col gap-3">
          {locations.map((loc) => (
            <li key={loc.id ?? 'default'} className="rounded-md border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{loc.label}</span>
                  {loc.isDefault && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Default
                    </span>
                  )}
                  <div className="font-mono text-xs text-slate-400">{loc.path}</div>
                </div>
                {!loc.isDefault && (
                  <button className="btn-xs btn-xs-danger" onClick={() => handleDelete(loc)}>
                    Remove
                  </button>
                )}
              </div>
              {loc.disk ? (
                <>
                  <ProgressBar fraction={loc.disk.usedPercent / 100} level={loc.disk.level} />
                  <div className="mt-1 flex justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>Free: {formatBytes(loc.disk.freeBytes)}</span>
                    <span>Total: {formatBytes(loc.disk.totalBytes)}</span>
                    <span>{loc.torrentCount} torrent(s)</span>
                  </div>
                </>
              ) : (
                <div className="text-xs text-amber-600 dark:text-amber-400">Disk stats unavailable (path unreachable?)</div>
              )}
            </li>
          ))}
        </ul>
      )}

      {addError && (
        <div className="mb-4 whitespace-pre-line rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {addError}
        </div>
      )}

      <form onSubmit={handleAdd} className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Label</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Disk 2" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Absolute path on the server</label>
          <input
            className="input font-mono"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/mnt/disk2/torrents"
            required
          />
        </div>
        <button type="submit" disabled={adding} className="btn mt-1">
          Add storage location
        </button>
      </form>

      <ConfirmDialog
        options={confirm?.options ?? null}
        onConfirm={() => { const c = confirm; setConfirm(null); c?.run(); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
