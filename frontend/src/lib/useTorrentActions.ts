import { useState, useCallback } from 'react';
import { api } from './api';
import { useToast } from './ToastContext';
import type { Torrent } from '../types';
import type { ConfirmOptions } from '../components/ConfirmDialog';

export function useTorrentActions(onChanged: () => void) {
  const { notify } = useToast();
  const [confirm, setConfirm] = useState<{ options: ConfirmOptions; run: () => Promise<void> } | null>(null);

  async function run(promise: Promise<unknown>, successMsg: string) {
    try {
      await promise;
      notify(successMsg, 'success');
      onChanged();
    } catch (err: any) {
      notify(err.message ?? 'Action failed', 'error');
    }
  }

  const onPause = useCallback((t: Torrent) => run(api.post(`/torrents/${t.id}/pause`), `Paused "${t.name}"`), [onChanged]);
  const onResume = useCallback((t: Torrent) => run(api.post(`/torrents/${t.id}/resume`), `Resumed "${t.name}"`), [onChanged]);
  const onStop = useCallback((t: Torrent) => run(api.post(`/torrents/${t.id}/stop`), `Stopped "${t.name}"`), [onChanged]);
  const onRecheck = useCallback((t: Torrent) => run(api.post(`/torrents/${t.id}/recheck`), `Recheck started for "${t.name}"`), [onChanged]);

  const onDelete = useCallback((t: Torrent) => {
    setConfirm({
      options: { title: 'Delete torrent', message: `Remove "${t.name}" from IHS Torrent Manager? Downloaded files will be kept.`, confirmLabel: 'Delete', danger: true },
      run: () => run(api.del(`/torrents/${t.id}`), `Deleted "${t.name}"`),
    });
  }, [onChanged]);

  const onDeleteWithData = useCallback((t: Torrent) => {
    setConfirm({
      options: { title: 'Delete torrent and data', message: `Permanently delete "${t.name}" AND all downloaded files? This cannot be undone.`, confirmLabel: 'Delete permanently', danger: true },
      run: () => run(api.del(`/torrents/${t.id}?deleteData=true`), `Deleted "${t.name}" and its data`),
    });
  }, [onChanged]);

  const onDownload = useCallback(async (t: Torrent) => {
    // Two-step flow: mint a short-lived, opaque token via the authenticated
    // API (never exposes the real filename or the torrent's numeric id),
    // then navigate to that one-purpose link to actually fetch the bytes.
    try {
      const res = await api.post<{ url: string }>(`/torrents/${t.id}/download-link`);
      window.location.href = res.url;
    } catch (err: any) {
      notify(err.message ?? 'Unable to start download', 'error');
    }
  }, [notify]);

  return {
    actions: { onPause, onResume, onStop, onDelete, onDeleteWithData, onRecheck, onDownload },
    confirmDialog: confirm?.options ?? null,
    confirmAction: () => {
      const c = confirm;
      setConfirm(null);
      c?.run();
    },
    cancelConfirm: () => setConfirm(null),
  };
}
