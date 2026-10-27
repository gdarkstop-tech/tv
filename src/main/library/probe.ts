import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util/exec';

// Media metadata and thumbnails. Uses ffprobe/ffmpeg when installed and falls
// back to mpv (which NOVA requires anyway), so the library works with mpv only.

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
  hdr: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

function parseRate(r: string | undefined): number | null {
  if (!r) return null;
  const [a, b] = r.split('/').map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

export function parseFfprobe(json: string): ProbeResult {
  const d = JSON.parse(json) as {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; color_transfer?: string; disposition?: { attached_pic?: number } }>;
  };
  const streams = d.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const tags = Object.fromEntries(Object.entries(d.format?.tags ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
  const trc = v?.color_transfer;
  return {
    duration: d.format?.duration ? Number(d.format.duration) : null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
    hdr: trc === 'smpte2084' ? 'HDR10' : trc === 'arib-std-b67' ? 'HLG' : null,
    title: tags.title ?? null,
    artist: tags.artist ?? tags.album_artist ?? null,
    album: tags.album ?? null,
  };
}

const MPV_PROBE_FORMAT =
  'NOVAPROBE|${=duration}|${=track-list/0/type}|${=track-list/0/demux-w}|${=track-list/0/demux-h}|${=track-list/0/codec}|${=container-fps}|${=video-params/gamma}|${=metadata/by-key/title}|${=metadata/by-key/artist}|${=metadata/by-key/album}|${=audio-codec-name}';

export function parseMpvProbe(text: string): ProbeResult | null {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('NOVAPROBE|'));
  if (!line) return null;
  const f = line.split('|');
  const num = (s: string | undefined) => {
    const n = Number(s);
    return s && Number.isFinite(n) && n > 0 ? n : null;
  };
  const str = (s: string | undefined) => (s && s !== '(unavailable)' ? s : null);
  const isVideo = f[2] === 'video';
  const gamma = str(f[7]);
  return {
    duration: num(f[1]),
    width: isVideo ? num(f[3]) : null,
    height: isVideo ? num(f[4]) : null,
    videoCodec: isVideo ? str(f[5]) : null,
    audioCodec: str(f[11]),
    fps: isVideo ? num(f[6]) : null,
    hdr: gamma === 'pq' ? 'HDR10' : gamma === 'hlg' ? 'HLG' : null,
    title: str(f[8]),
    artist: str(f[9]),
    album: str(f[10]),
  };
}

export async function probeFile(file: string, tools: { ffprobe: string | null; mpv: string | null }): Promise<ProbeResult | null> {
  if (tools.ffprobe) {
    const r = await run(tools.ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 20000 });
    if (r.ok) {
      try {
        return parseFfprobe(r.stdout);
      } catch {
        // fall back to mpv
      }
    }
  }
  if (tools.mpv) {
    const r = await run(tools.mpv, ['--no-config', '--vo=null', '--ao=null', '--frames=1', '--ytdl=no', `--term-playing-msg=${MPV_PROBE_FORMAT}`, file], { timeoutMs: 20000 });
    return parseMpvProbe(r.stdout + '\n' + r.stderr);
  }
  return null;
}

/** Create a 480px-wide JPEG thumbnail at ~25% into the video. */
export async function makeThumbnail(file: string, outFile: string, duration: number | null, tools: { ffmpeg: string | null; mpv: string | null }): Promise<boolean> {
  const at = duration && duration > 4 ? Math.min(duration * 0.25, 600) : 1;
  if (tools.ffmpeg) {
    const r = await run(tools.ffmpeg, ['-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile], { timeoutMs: 30000 });
    if (r.ok && fs.existsSync(outFile)) return true;
  }
  if (tools.mpv) {
    const tmp = fs.mkdtempSync(path.join(path.dirname(outFile), 'thumb-'));
    try {
      await run(
        tools.mpv,
        ['--no-config', '--ao=null', '--vo=image', '--vo-image-format=jpg', `--vo-image-outdir=${tmp}`, `--start=${at.toFixed(2)}`, '--frames=1', '--vf=scale=480:-2', '--hwdec=no', '--ytdl=no', file],
        { timeoutMs: 30000 },
      );
      const produced = fs.readdirSync(tmp).find((f) => f.endsWith('.jpg'));
      if (produced) {
        fs.renameSync(path.join(tmp, produced), outFile);
        return true;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return false;
}
