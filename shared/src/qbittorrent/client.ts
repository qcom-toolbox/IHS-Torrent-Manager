import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';

export interface QbtTorrentInfo {
  hash: string;
  name: string;
  size: number;
  progress: number; // 0..1
  dlspeed: number;
  upspeed: number;
  eta: number;
  state: string;
  save_path: string;
  category: string;
  completion_on: number; // unix timestamp, -1/0 if not completed
  added_on: number;
}

export interface QbtFileInfo {
  name: string;
  size: number;
  progress: number;
  is_seed?: boolean;
}

const QBT_TERMINAL_ERROR_STATES = new Set(['error', 'missingFiles']);
const QBT_PAUSED_STATES = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
const QBT_COMPLETED_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'queuedUP', 'checkingUP', 'forcedUP', 'stoppedUP']);
const QBT_DOWNLOADING_STATES = new Set([
  'downloading',
  'metaDL',
  'stalledDL',
  'queuedDL',
  'checkingDL',
  'forcedDL',
  'allocating',
]);

export function mapQbtState(state: string): string {
  if (QBT_TERMINAL_ERROR_STATES.has(state)) return 'error';
  if (QBT_PAUSED_STATES.has(state)) {
    // qBittorrent v5 renamed pause->stop; treat both as "paused" from the
    // user's perspective unless upload finished, which we surface as completed.
    return state.startsWith('stoppedUP') || state === 'pausedUP' ? 'completed' : 'paused';
  }
  if (QBT_COMPLETED_STATES.has(state)) return 'completed';
  if (QBT_DOWNLOADING_STATES.has(state)) return 'downloading';
  if (state === 'moving') return 'downloading';
  return 'queued';
}

// mapQbtState() collapses both "completed and actively seeding" and
// "completed but already paused" into our single 'completed' status (the
// UI doesn't need the distinction), which means that status alone can't
// tell the uploads-disabled enforcement whether a given torrent still
// needs pausing. This checks the raw qBittorrent state instead.
const QBT_ACTIVELY_UPLOADING_STATES = new Set(['uploading', 'stalledUP', 'queuedUP', 'checkingUP', 'forcedUP']);
export function isActivelyUploading(state: string): boolean {
  return QBT_ACTIVELY_UPLOADING_STATES.has(state);
}

/** True for any state mapQbtState() would classify as 'downloading' or 'queued'/'allocating'/'moving' -- i.e. anything the downloads-disabled policy should pause. */
export function isActivelyDownloading(state: string): boolean {
  return QBT_DOWNLOADING_STATES.has(state) || state === 'moving';
}

export class QbtAuthError extends Error {}
export class QbtApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export class QbittorrentClient {
  private http: AxiosInstance;
  private cookie: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 15000,
      validateStatus: () => true,
    });
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.cookie) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async login(): Promise<void> {
    const form = new URLSearchParams();
    form.set('username', this.username);
    form.set('password', this.password);
    const res = await this.http.post('/api/v2/auth/login', form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: this.baseUrl,
      },
    });
    if (res.status !== 200 || res.data !== 'Ok.') {
      throw new QbtAuthError(`qBittorrent login failed: HTTP ${res.status}`);
    }
    const setCookie = res.headers['set-cookie'];
    if (!setCookie || setCookie.length === 0) {
      throw new QbtAuthError('qBittorrent login did not return a session cookie');
    }
    this.cookie = setCookie[0].split(';')[0];
  }

  private async request(method: 'GET' | 'POST', url: string, opts: {
    params?: Record<string, any>;
    data?: any;
    headers?: Record<string, string>;
    responseType?: 'json' | 'arraybuffer';
  } = {}, retried = false): Promise<any> {
    await this.ensureLoggedIn();
    const res = await this.http.request({
      method,
      url,
      params: opts.params,
      data: opts.data,
      headers: { ...opts.headers, Cookie: this.cookie ?? '', Referer: this.baseUrl },
      responseType: opts.responseType,
    });

    if (res.status === 403 && !retried) {
      // Session expired -- force re-login once and retry.
      this.cookie = null;
      return this.request(method, url, opts, true);
    }
    if (res.status >= 400) {
      throw new QbtApiError(`qBittorrent API error: ${method} ${url} -> HTTP ${res.status}`, res.status);
    }
    return res.data;
  }

  // qBittorrent 5.0's WebAPI renamed torrents/pause -> torrents/stop and
  // torrents/resume -> torrents/start (same request shape, just a new
  // path); older versions only have the original names. Rather than
  // parsing WebAPI version numbers, try the candidates in order and
  // remember whichever one actually works (per action, per client
  // instance) so it's only a single extra round-trip ever, on first use.
  private resolvedActionPaths: Record<string, string> = {};

  private async postWithFallback(actionKey: string, candidatePaths: string[], data: string): Promise<void> {
    const cached = this.resolvedActionPaths[actionKey];
    const order = cached ? [cached, ...candidatePaths.filter((p) => p !== cached)] : candidatePaths;

    let lastErr: unknown;
    for (const path of order) {
      try {
        await this.request('POST', path, {
          data,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        this.resolvedActionPaths[actionKey] = path;
        return;
      } catch (err) {
        lastErr = err;
        // Only keep trying alternates for "this endpoint doesn't exist on
        // this qBittorrent version" (404). Any other error (auth, 5xx,
        // network) is real and should surface immediately, not be masked
        // by trying every candidate path.
        if (!(err instanceof QbtApiError) || err.status !== 404) throw err;
      }
    }
    throw lastErr;
  }

  async version(): Promise<string> {
    return this.request('GET', '/api/v2/app/version');
  }

  async listTorrents(hashes?: string[]): Promise<QbtTorrentInfo[]> {
    const params: Record<string, any> = {};
    if (hashes && hashes.length > 0) params.hashes = hashes.join('|');
    return this.request('GET', '/api/v2/torrents/info', { params });
  }

  async getFiles(hash: string): Promise<QbtFileInfo[]> {
    return this.request('GET', '/api/v2/torrents/files', { params: { hash } });
  }

  async addTorrentFile(
    fileBuffer: Buffer,
    filename: string,
    opts: { savepath: string; category?: string }
  ): Promise<void> {
    await this.ensureLoggedIn();
    const form = new FormData();
    form.append('torrents', fileBuffer, { filename });
    form.append('savepath', opts.savepath);
    if (opts.category) form.append('category', opts.category);
    form.append('autoTMM', 'false');

    const res = await this.http.post('/api/v2/torrents/add', form, {
      headers: { ...form.getHeaders(), Cookie: this.cookie ?? '', Referer: this.baseUrl },
    });
    if (res.status !== 200 || String(res.data).trim() !== 'Ok.') {
      throw new QbtApiError(`Failed to add torrent: HTTP ${res.status} ${res.data}`);
    }
  }

  async pause(hashes: string[]): Promise<void> {
    const data = new URLSearchParams({ hashes: hashes.join('|') }).toString();
    await this.postWithFallback('pause', ['/api/v2/torrents/pause', '/api/v2/torrents/stop'], data);
  }

  async resume(hashes: string[]): Promise<void> {
    const data = new URLSearchParams({ hashes: hashes.join('|') }).toString();
    await this.postWithFallback('resume', ['/api/v2/torrents/resume', '/api/v2/torrents/start'], data);
  }

  async recheck(hashes: string[]): Promise<void> {
    await this.request('POST', '/api/v2/torrents/recheck', {
      data: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async delete(hashes: string[], deleteFiles: boolean): Promise<void> {
    await this.request('POST', '/api/v2/torrents/delete', {
      data: new URLSearchParams({
        hashes: hashes.join('|'),
        deleteFiles: deleteFiles ? 'true' : 'false',
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /** Global (not per-torrent) speed limits, in bytes/sec. 0 means unlimited. */
  async getSpeedLimits(): Promise<{ downloadLimit: number; uploadLimit: number }> {
    const [dl, ul] = await Promise.all([
      this.request('GET', '/api/v2/transfer/downloadLimit'),
      this.request('GET', '/api/v2/transfer/uploadLimit'),
    ]);
    return { downloadLimit: Number(dl) || 0, uploadLimit: Number(ul) || 0 };
  }

  async setSpeedLimits(downloadLimitBytesPerSec: number, uploadLimitBytesPerSec: number): Promise<void> {
    await Promise.all([
      this.request('POST', '/api/v2/transfer/setDownloadLimit', {
        data: new URLSearchParams({ limit: String(Math.max(0, Math.trunc(downloadLimitBytesPerSec))) }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
      this.request('POST', '/api/v2/transfer/setUploadLimit', {
        data: new URLSearchParams({ limit: String(Math.max(0, Math.trunc(uploadLimitBytesPerSec))) }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    ]);
  }
}
