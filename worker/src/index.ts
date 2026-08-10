import {
  loadSharedConfig,
  loadQbtConfig,
  runMigrations,
  getDb,
  Torrents,
  TorrentEvents,
  QbittorrentClient,
  mapQbtState,
} from '@torrent-manager/shared';

const shared = loadSharedConfig();
const qbtConfig = loadQbtConfig();

let qbt = new QbittorrentClient(qbtConfig.torrentHost, qbtConfig.torrentUsername, qbtConfig.torrentPassword);
let consecutiveFailures = 0;
let running = true;

async function syncOnce(): Promise<void> {
  const dbTorrents = Torrents.all();
  if (dbTorrents.length === 0) {
    consecutiveFailures = 0;
    return;
  }

  const qbtTorrents = await qbt.listTorrents();
  const byHash = new Map(qbtTorrents.map((t) => [t.hash.toLowerCase(), t]));
  const presentHashes: string[] = [];

  for (const local of dbTorrents) {
    const remote = byHash.get(local.torrent_hash.toLowerCase());
    if (!remote) continue;
    presentHashes.push(local.torrent_hash);

    const newStatus = mapQbtState(remote.state);
    const wasCompleted = local.status === 'completed';
    const nowCompleted = newStatus === 'completed';

    Torrents.updateSyncState(local.torrent_hash, {
      status: newStatus as any,
      progress: Math.max(0, Math.min(1, remote.progress)),
      download_speed: remote.dlspeed,
      upload_speed: remote.upspeed,
      size: remote.size,
      eta_seconds: remote.eta > 0 && remote.eta < 8640000 ? remote.eta : null,
      save_path: remote.save_path,
      is_dir: 0,
      error_message: newStatus === 'error' ? 'qBittorrent reported an error state for this torrent' : null,
      completed_at: nowCompleted && !wasCompleted ? new Date().toISOString() : local.completed_at,
      display_name: remote.name || local.display_name,
    });

    if (nowCompleted && !wasCompleted) {
      TorrentEvents.add(local.id, 'completed', 'Download finished');
    } else if (newStatus === 'error' && local.status !== 'error') {
      TorrentEvents.add(local.id, 'error', 'qBittorrent reported an error');
    }
  }

  // Anything in our DB that qBittorrent no longer knows about (manually
  // removed from qBittorrent directly, etc.) is surfaced as "missing"
  // rather than silently left stale.
  const missingLocal = dbTorrents.filter((t) => !presentHashes.includes(t.torrent_hash) && t.status !== 'missing');
  for (const t of missingLocal) {
    Torrents.updateSyncState(t.torrent_hash, { status: 'missing' as any });
    TorrentEvents.add(t.id, 'missing', 'No longer present in qBittorrent');
  }

  consecutiveFailures = 0;
}

async function tick(): Promise<void> {
  try {
    await syncOnce();
  } catch (err: any) {
    consecutiveFailures++;
    console.error(`[worker] sync failed (attempt ${consecutiveFailures}):`, err.message);
    // If qBittorrent was restarted our session cookie is stale; force a
    // fresh login on the next attempt rather than looping on 403s forever.
    if (consecutiveFailures % 3 === 0) {
      qbt = new QbittorrentClient(qbtConfig.torrentHost, qbtConfig.torrentUsername, qbtConfig.torrentPassword);
    }
  } finally {
    if (running) {
      setTimeout(tick, qbtConfig.workerSyncIntervalMs);
    }
  }
}

function shutdown(): void {
  running = false;
  console.log('[worker] shutting down');
  getDb().close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function main(): void {
  const applied = runMigrations(shared.databasePath);
  if (applied.length > 0) {
    console.log(`[worker] applied ${applied.length} pending migration(s)`);
  }
  console.log(`[worker] starting sync loop (interval ${qbtConfig.workerSyncIntervalMs}ms)`);
  tick();
}

main();
