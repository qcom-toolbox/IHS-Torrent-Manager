/**
 * Minimal, defensive bencode decoder used only to confirm an uploaded file
 * is structurally a valid .torrent (has a top-level dict with an "info"
 * dict containing "name" and piece data). We intentionally don't build a
 * full torrent parser -- qBittorrent does the real parsing -- this is just
 * enough to reject garbage/malicious uploads before they reach the qBittorrent
 * API, with strict depth/size limits to avoid DoS on crafted input.
 */

import * as crypto from 'crypto';

const MAX_DEPTH = 64;

class BDecoder {
  private pos = 0;
  constructor(private buf: Buffer) {}

  decode(depth = 0): any {
    if (depth > MAX_DEPTH) throw new Error('bencode: max depth exceeded');
    if (this.pos >= this.buf.length) throw new Error('bencode: unexpected end');
    const byte = this.buf[this.pos];
    if (byte === 0x64 /* 'd' */) return this.decodeDict(depth);
    if (byte === 0x6c /* 'l' */) return this.decodeList(depth);
    if (byte === 0x69 /* 'i' */) return this.decodeInt();
    if (byte >= 0x30 && byte <= 0x39 /* '0'-'9' */) return this.decodeString();
    throw new Error(`bencode: unexpected token at ${this.pos}`);
  }

  private decodeDict(depth: number): Record<string, any> {
    this.pos++; // 'd'
    const dict: Record<string, any> = {};
    let count = 0;
    while (this.buf[this.pos] !== 0x65 /* 'e' */) {
      if (this.pos >= this.buf.length) throw new Error('bencode: unterminated dict');
      if (++count > 10000) throw new Error('bencode: too many dict entries');
      const key = this.decodeString();
      const value = this.decode(depth + 1);
      dict[key.toString('latin1')] = value;
    }
    this.pos++; // 'e'
    return dict;
  }

  private decodeList(depth: number): any[] {
    this.pos++; // 'l'
    const list: any[] = [];
    let count = 0;
    while (this.buf[this.pos] !== 0x65 /* 'e' */) {
      if (this.pos >= this.buf.length) throw new Error('bencode: unterminated list');
      if (++count > 100000) throw new Error('bencode: list too large');
      list.push(this.decode(depth + 1));
    }
    this.pos++; // 'e'
    return list;
  }

  private decodeInt(): number {
    this.pos++; // 'i'
    const end = this.buf.indexOf(0x65, this.pos); // 'e'
    if (end === -1) throw new Error('bencode: unterminated integer');
    const str = this.buf.toString('ascii', this.pos, end);
    if (!/^-?\d+$/.test(str)) throw new Error('bencode: invalid integer');
    this.pos = end + 1;
    return parseInt(str, 10);
  }

  private decodeString(): Buffer {
    const colon = this.buf.indexOf(0x3a, this.pos); // ':'
    if (colon === -1) throw new Error('bencode: invalid string length');
    const lenStr = this.buf.toString('ascii', this.pos, colon);
    if (!/^\d{1,9}$/.test(lenStr)) throw new Error('bencode: invalid string length');
    const len = parseInt(lenStr, 10);
    const start = colon + 1;
    const end = start + len;
    if (end > this.buf.length) throw new Error('bencode: string length overruns buffer');
    this.pos = end;
    return this.buf.subarray(start, end);
  }
}

export interface TorrentValidationResult {
  valid: boolean;
  name?: string;
  reason?: string;
  infoHash?: string;
}

/**
 * Computes the BitTorrent v1 info-hash (SHA1 over the raw, original bytes
 * of the top-level "info" dict) so the app can correlate its DB record with
 * qBittorrent's reported torrent hash immediately after upload, without
 * waiting on a subsequent sync pass.
 */
function computeInfoHash(buf: Buffer): string | undefined {
  try {
    if (buf[0] !== 0x64) return undefined; // must start with 'd'
    let pos = 1;
    while (buf[pos] !== 0x65) {
      // read a dict key (bencoded string)
      const colon = buf.indexOf(0x3a, pos);
      if (colon === -1) return undefined;
      const lenStr = buf.toString('ascii', pos, colon);
      if (!/^\d{1,9}$/.test(lenStr)) return undefined;
      const len = parseInt(lenStr, 10);
      const keyStart = colon + 1;
      const keyEnd = keyStart + len;
      if (keyEnd > buf.length) return undefined;
      const key = buf.toString('latin1', keyStart, keyEnd);

      const valueStart = keyEnd;
      const valueEnd = skipValue(buf, valueStart);
      if (valueEnd === -1) return undefined;

      if (key === 'info') {
        return crypto.createHash('sha1').update(buf.subarray(valueStart, valueEnd)).digest('hex');
      }
      pos = valueEnd;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Skips one bencoded value (string/int/list/dict) starting at `pos`, returning the position right after it, or -1 on malformed input. */
function skipValue(buf: Buffer, pos: number, depth = 0): number {
  if (depth > MAX_DEPTH || pos >= buf.length) return -1;
  const byte = buf[pos];

  if (byte === 0x64 /* 'd' */) {
    let p = pos + 1;
    while (buf[p] !== 0x65 /* 'e' */) {
      p = skipValue(buf, p, depth + 1); // key (bencoded string)
      if (p === -1) return -1;
      p = skipValue(buf, p, depth + 1); // value
      if (p === -1) return -1;
    }
    return p + 1;
  }

  if (byte === 0x6c /* 'l' */) {
    let p = pos + 1;
    while (buf[p] !== 0x65 /* 'e' */) {
      p = skipValue(buf, p, depth + 1);
      if (p === -1) return -1;
    }
    return p + 1;
  }

  if (byte === 0x69 /* 'i' */) {
    const end = buf.indexOf(0x65, pos);
    return end === -1 ? -1 : end + 1;
  }

  if (byte >= 0x30 && byte <= 0x39 /* '0'-'9' */) {
    const colon = buf.indexOf(0x3a, pos);
    if (colon === -1) return -1;
    const lenStr = buf.toString('ascii', pos, colon);
    if (!/^\d{1,9}$/.test(lenStr)) return -1;
    const len = parseInt(lenStr, 10);
    const end = colon + 1 + len;
    return end > buf.length ? -1 : end;
  }

  return -1;
}

export function validateTorrentFile(buf: Buffer): TorrentValidationResult {
  try {
    if (buf.length < 10 || buf.length > 25 * 1024 * 1024) {
      return { valid: false, reason: 'File size out of range for a .torrent file' };
    }
    const decoder = new BDecoder(buf);
    const root = decoder.decode();
    if (typeof root !== 'object' || Array.isArray(root) || root === null) {
      return { valid: false, reason: 'Not a valid bencoded dictionary' };
    }
    const info = root['info'];
    if (!info || typeof info !== 'object') {
      return { valid: false, reason: 'Missing required "info" dictionary' };
    }
    const name = info['name'];
    if (!Buffer.isBuffer(name)) {
      return { valid: false, reason: 'Missing required "info.name" field' };
    }
    const hasFiles = Array.isArray(info['files']);
    const hasSingleLength = typeof info['length'] === 'number';
    if (!hasFiles && !hasSingleLength) {
      return { valid: false, reason: 'Torrent info missing file length data' };
    }
    const infoHash = computeInfoHash(buf);
    if (!infoHash) {
      return { valid: false, reason: 'Unable to compute torrent info-hash' };
    }
    return { valid: true, name: name.toString('utf-8').slice(0, 255), infoHash };
  } catch (err: any) {
    return { valid: false, reason: `Malformed torrent file: ${err.message}` };
  }
}
