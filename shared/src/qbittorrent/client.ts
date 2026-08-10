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

export class QbtAuthError extends Error {}
export class QbtApiError extends Error {}

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
      throw new QbtApiError(`qBittorrent API error: ${method} ${url} -> HTTP ${res.status}`);
    }
    return res.data;
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
    await this.request('POST', '/api/v2/torrents/pause', {
      data: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async resume(hashes: string[]): Promise<void> {
    await this.request('POST', '/api/v2/torrents/resume', {
      data: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
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
}
