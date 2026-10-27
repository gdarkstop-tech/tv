import crypto from 'node:crypto';
import path from 'node:path';
import type { Settings } from '../../shared/settings';

// Builds the mpv command line. Pure so it can be unit-tested.

export interface MpvLaunchOptions {
  ipcPath: string;
  /** Native window handle to embed into (HWND on Windows, X11 window id on Linux). */
  wid: bigint | null;
  /** Physical-pixel geometry for standalone mode. */
  geometry: { x: number; y: number; width: number; height: number } | null;
  logFile: string | null;
  screenshotDir: string;
  settings: Settings;
}

export function ipcPathFor(runtimeDir: string, platform: NodeJS.Platform = process.platform): string {
  const id = crypto.randomBytes(8).toString('hex');
  // Windows named pipes created by mpv reject remote clients; the random
  // name keeps other local programs from guessing it.
  if (platform === 'win32') return `\\\\.\\pipe\\nova-mpv-${process.pid}-${id}`;
  return path.join(runtimeDir, `mpv-${id}.sock`);
}

export function buildMpvArgs(o: MpvLaunchOptions): string[] {
  const s = o.settings;
  const args = [
    '--no-config',
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    `--input-ipc-server=${o.ipcPath}`,
    // NOVA owns all input: mpv must not react to keys or the mouse.
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    '--input-cursor=no',
    '--cursor-autohide=always',
    '--no-osc',
    '--osd-level=0',
    '--no-terminal',
    '--msg-level=all=warn',
    // Never reach out to the network on our own.
    '--ytdl=no',
    '--save-position-on-quit=no',
    '--title=NOVA Video',
    '--vo=gpu-next,gpu,',
    // Allow software OpenGL as a last resort (e.g. basic display drivers):
    // a slow picture is better than a black screen. The Performance Manager
    // reports it.
    '--gpu-sw=yes',
    `--hwdec=${s.playback.hardwareDecoding === 'off' ? 'no' : 'auto-safe'}`,
    '--image-display-duration=inf',
    '--audio-display=no',
    '--sub-auto=fuzzy',
    `--sub-scale=${s.playback.subtitleScale}`,
    `--volume=${s.audio.volume}`,
    '--volume-max=130',
    `--audio-device=${s.audio.device || 'auto'}`,
    `--screenshot-directory=${o.screenshotDir}`,
    '--screenshot-format=png',
  ];
  if (s.playback.preferredAudioLanguage) args.push(`--alang=${s.playback.preferredAudioLanguage}`);
  if (s.playback.preferredSubtitleLanguage) args.push(`--slang=${s.playback.preferredSubtitleLanguage}`);
  if (s.audio.passthrough) args.push('--audio-spdif=ac3,eac3,dts,dts-hd,truehd');
  if (o.logFile) args.push(`--log-file=${o.logFile}`);
  if (o.wid !== null) {
    args.push(`--wid=${o.wid.toString()}`);
  } else if (o.geometry) {
    const g = o.geometry;
    args.push('--no-border', `--geometry=${g.width}x${g.height}+${g.x}+${g.y}`, '--ontop=no', '--no-keepaspect-window');
  } else {
    args.push('--fs');
  }
  return args;
}

/** Parse "mpv 0.37.0" / "mpv v0.38.0-…" into [major, minor]. */
export function parseMpvVersion(v: string | null | undefined): [number, number] | null {
  const m = (v ?? '').match(/v?(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** loadfile gained an <index> argument in mpv 0.38; options moved to the 4th slot. */
export function loadfileCommand(file: string, startSeconds: number | null, version: [number, number] | null): unknown[] {
  const opts = startSeconds && startSeconds > 0 ? `start=${startSeconds.toFixed(2)}` : '';
  if (!opts) return ['loadfile', file, 'replace'];
  const newSyntax = version !== null && (version[0] > 0 || version[1] >= 38);
  return newSyntax ? ['loadfile', file, 'replace', -1, opts] : ['loadfile', file, 'replace', opts];
}
