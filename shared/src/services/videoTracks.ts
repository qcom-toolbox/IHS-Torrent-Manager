import { execFile } from 'child_process';

export interface AudioTrackInfo {
  /** Index among audio streams only -- what ffmpeg's `-map 0:a:<n>` selector expects. */
  audioIndex: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
  /** Whether the container itself flags this as the default audio stream (ffmpeg picks this one when no -map is given). */
  isDefault: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  disposition?: { default?: number };
  tags?: Record<string, string>;
}

/**
 * Lists the audio tracks embedded in a video file via `ffprobe`, purely for
 * display/selection purposes -- this never touches the file's bytes. Runs
 * `ffprobe` with an argument array (no shell), so there's no command
 * injection surface even though `absPath` ultimately derives from
 * torrent-controlled data (it's already been through `safeResolve()` by
 * the time it reaches here).
 *
 * Returns an empty array if `ffprobe` is missing, times out, or the file
 * can't be parsed -- callers treat that identically to "one (default)
 * track": the file still plays, it just won't offer a track switcher.
 */
export function probeAudioTracks(absPath: string): Promise<AudioTrackInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_entries', 'stream=codec_type,codec_name,channels,disposition:stream_tags=language,title', absPath],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
          const audioStreams = (parsed.streams ?? []).filter((s) => s.codec_type === 'audio');
          resolve(
            audioStreams.map((s, audioIndex) => ({
              audioIndex,
              language: s.tags?.language ?? null,
              title: s.tags?.title ?? null,
              codec: s.codec_name ?? null,
              channels: s.channels ?? null,
              // Only trust an explicit disposition flag; if none of the
              // audio streams are flagged, ffmpeg/most players fall back to
              // the first one, so audioIndex 0 is treated as default below.
              isDefault: s.disposition?.default === 1,
            }))
          );
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/** Human-readable label for a track, in the same "best available field" order the UI shows. */
export function audioTrackLabel(track: AudioTrackInfo): string {
  if (track.title) return track.title;
  if (track.language) return track.language.toUpperCase();
  return `Track ${track.audioIndex + 1}`;
}

/**
 * Which track plays when no ?track query param is given (the fast,
 * Range-enabled /stream path) -- whichever stream is disposition-flagged
 * default, else audioIndex 0 (ffmpeg's own fallback when nothing is
 * flagged), else null if the file has no audio streams at all.
 */
export function defaultAudioTrackIndex(tracks: AudioTrackInfo[]): number | null {
  if (tracks.length === 0) return null;
  return tracks.find((t) => t.isDefault)?.audioIndex ?? 0;
}

// Audio codecs the HTML5 <video> element can actually decode in mainstream
// browsers. Verified directly (not just from docs): an AC-3 track played
// back with maxDeviation=0 on an AnalyserNode -- video decoded and played
// fine, audio was pure silence, no error event at all. This is extremely
// common on torrent releases (AC-3/DTS/TrueHD are typical for remuxed
// Blu-ray/DVD rips), so it isn't an edge case worth ignoring.
const BROWSER_DECODABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/** Whether this track's audio codec needs transcoding to be audible in a browser at all (independent of container). */
export function needsAudioTranscode(track: Pick<AudioTrackInfo, 'codec'>): boolean {
  return !track.codec || !BROWSER_DECODABLE_AUDIO_CODECS.has(track.codec.toLowerCase());
}
