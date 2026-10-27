import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaKind, PlayerCommand, PlayerState, PlayerTrack } from '../../shared/types';
import type { NovaDatabase } from '../db';
import { locateTool, toolInfo } from '../hardware/tools';
import { logger } from '../log';
import { dataPaths } from '../paths';
import type { SettingsStore } from '../settings-store';
import { buildMpvArgs, ipcPathFor, loadfileCommand, parseMpvVersion } from './mpv-args';
import { MpvIpcClient, type MpvEvent } from './mpv-ipc';

const log = logger('player');

export interface PlayerHost {
  /** Native handle of the video window, or null when embedding is unsupported. */
  embedHandle(): bigint | null;
  /** Physical-pixel rectangle of the TV for standalone mode. */
  standaloneGeometry(): { x: number; y: number; width: number; height: number } | null;
}

export interface OpenRequest {
  mediaId?: string;
  /** Internal use only (calibration preview, self-test). Never accepted from the renderer or remote. */
  path?: string;
  title?: string;
  kind?: MediaKind;
  queue?: string[];
  resume?: boolean;
}

const OBSERVED = [
  'pause',
  'time-pos',
  'duration',
  'volume',
  'mute',
  'track-list',
  'video-params',
  'video-codec',
  'hwdec-current',
  'container-fps',
  'eof-reached',
  'idle-active',
  'audio-device',
  'demuxer-cache-duration',
  'paused-for-cache',
] as const;

function initialState(): PlayerState {
  return {
    status: 'idle',
    engine: { available: false, path: null, version: null, mode: 'none', restarts: 0 },
    media: null,
    position: 0,
    duration: 0,
    paused: false,
    volume: 100,
    muted: false,
    tracks: [],
    video: null,
    audioDevice: null,
    error: null,
    bufferingSeconds: null,
    queue: { index: 0, length: 0 },
  };
}

export class PlayerService extends EventEmitter {
  private proc: ChildProcess | null = null;
  private ipc: MpvIpcClient | null = null;
  private starting: Promise<MpvIpcClient> | null = null;
  private stateValue: PlayerState = initialState();
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmit = 0;
  private lastHistorySave = 0;
  private mpvVersion: [number, number] | null = null;
  private queue: string[] = [];
  private queueIndex = 0;
  private restartTimes: number[] = [];
  private expectedExit = false;
  private pendingResume: { mediaId: string; position: number } | null = null;
  private endedHandled = false;
  private disposed = false;

  constructor(
    private readonly db: NovaDatabase,
    private readonly settings: SettingsStore,
    private readonly host: PlayerHost,
  ) {
    super();
  }

  get state(): PlayerState {
    return structuredClone(this.stateValue);
  }

  get client(): MpvIpcClient | null {
    return this.ipc?.connected ? this.ipc : null;
  }

  get version(): [number, number] | null {
    return this.mpvVersion;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async detectEngine(): Promise<boolean> {
    const info = await toolInfo('mpv', this.settings.get().tools.mpvPath);
    this.stateValue.engine.available = info.found;
    this.stateValue.engine.path = info.path;
    this.stateValue.engine.version = info.version;
    this.mpvVersion = parseMpvVersion(info.version);
    this.scheduleEmit(true);
    return info.found;
  }

  private patch(p: Partial<PlayerState>, immediate = false): void {
    Object.assign(this.stateValue, p);
    this.scheduleEmit(immediate);
  }

  private scheduleEmit(immediate: boolean): void {
    const now = Date.now();
    if (immediate || now - this.lastEmit > 250) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.lastEmit = now;
      this.emit('state', this.state);
      return;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.lastEmit = Date.now();
        this.emit('state', this.state);
      }, 250 - (now - this.lastEmit));
    }
  }

  /** Start mpv if it is not running and return a connected IPC client. */
  async ensureEngine(): Promise<MpvIpcClient> {
    if (this.ipc?.connected) return this.ipc;
    if (this.starting) return this.starting;
    this.starting = this.startEngine().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startEngine(): Promise<MpvIpcClient> {
    const settings = this.settings.get();
    const mpvPath = locateTool('mpv', settings.tools.mpvPath);
    if (!mpvPath) {
      this.patch({ engine: { ...this.stateValue.engine, available: false, mode: 'none' } }, true);
      throw new Error('mpv is not installed. Install mpv and restart NOVA (see Settings → Playback).');
    }
    if (!this.stateValue.engine.version) await this.detectEngine();
    const ipcPath = ipcPathFor(dataPaths.runtime());
    const wid = this.host.embedHandle();
    const args = buildMpvArgs({
      ipcPath,
      wid,
      geometry: wid === null ? this.host.standaloneGeometry() : null,
      logFile: path.join(dataPaths.logs(), 'mpv.log'),
      screenshotDir: dataPaths.cache(),
      settings,
    });
    try {
      fs.rmSync(path.join(dataPaths.logs(), 'mpv.log'), { force: true });
    } catch {
      // ignore
    }
    log.info('starting mpv', { mpvPath, mode: wid !== null ? 'embedded' : 'standalone' });
    this.expectedExit = false;
    const proc = spawn(mpvPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    this.proc = proc;
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => log.debug('mpv stderr', d.slice(0, 300)));
    proc.on('exit', (code, signal) => this.onEngineExit(code, signal));
    proc.on('error', (err) => log.error('mpv spawn error', err));

    const ipc = new MpvIpcClient(ipcPath, 8000);
    try {
      await ipc.connect(15000);
    } catch (err) {
      proc.kill();
      throw err;
    }
    this.ipc = ipc;
    ipc.on('property', (name: string, value: unknown) => this.onProperty(name, value));
    ipc.on('event', (evt: MpvEvent) => this.onEvent(evt));
    for (const p of OBSERVED) await ipc.observe(p).catch(() => undefined);
    const v = await ipc.getOr<string>('mpv-version', '');
    if (v) {
      this.mpvVersion = parseMpvVersion(v);
      this.stateValue.engine.version = v.replace(/^mpv\s+/, '');
    }
    this.patch(
      {
        engine: { ...this.stateValue.engine, available: true, path: mpvPath, mode: wid !== null ? 'embedded' : 'standalone' },
      },
      true,
    );
    this.emit('engine-ready', ipc);
    return ipc;
  }

  private onEngineExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasPlaying = this.stateValue.status === 'playing' || this.stateValue.status === 'paused' || this.stateValue.status === 'loading';
    const resumeMedia = this.stateValue.media;
    const resumePos = this.stateValue.position;
    this.ipc?.close();
    this.ipc = null;
    this.proc = null;
    if (this.expectedExit || this.disposed) return;
    log.warn('mpv exited unexpectedly', { code, signal });
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 60000);
    if (!wasPlaying || !resumeMedia) {
      this.patch({ status: 'idle', engine: { ...this.stateValue.engine, mode: 'none' } }, true);
      return;
    }
    if (this.restartTimes.length >= 3) {
      this.patch({ status: 'error', error: 'The video engine stopped repeatedly. Playback was halted to protect stability.' }, true);
      this.emit('error-message', 'The video engine stopped repeatedly. Playback was halted.');
      return;
    }
    this.restartTimes.push(now);
    this.stateValue.engine.restarts++;
    this.emit('error-message', 'The video engine stopped unexpectedly — recovering playback.');
    setTimeout(() => {
      void this.open({ mediaId: resumeMedia.id ?? undefined, path: resumeMedia.id ? undefined : resumeMedia.path, title: resumeMedia.title, kind: resumeMedia.kind, resume: false }, resumePos).catch((err) =>
        log.error('recovery failed', err),
      );
    }, 500);
  }

  private onProperty(name: string, value: unknown): void {
    const s = this.stateValue;
    switch (name) {
      case 'pause':
        s.paused = Boolean(value);
        if (s.status === 'playing' || s.status === 'paused') s.status = s.paused ? 'paused' : 'playing';
        if (s.paused) this.saveHistory(false);
        this.scheduleEmit(true);
        return;
      case 'time-pos':
        if (typeof value === 'number') {
          s.position = value;
          if (Date.now() - this.lastHistorySave > 10000) this.saveHistory(false);
        }
        break;
      case 'duration':
        s.duration = typeof value === 'number' ? value : 0;
        break;
      case 'volume':
        if (typeof value === 'number') s.volume = Math.round(value);
        break;
      case 'mute':
        s.muted = Boolean(value);
        break;
      case 'track-list':
        s.tracks = mapTracks(value);
        break;
      case 'video-params': {
        const vp = value as Record<string, unknown> | null;
        if (vp && typeof vp.w === 'number') {
          const gamma = typeof vp.gamma === 'string' ? vp.gamma : null;
          s.video = {
            width: vp.w as number,
            height: vp.h as number,
            fps: s.video?.fps ?? 0,
            codec: s.video?.codec ?? null,
            hwdec: s.video?.hwdec ?? null,
            pixelFormat: (vp.pixelformat as string) ?? null,
            hdr: gamma === 'pq' || gamma === 'hlg',
            primaries: (vp.primaries as string) ?? null,
            transfer: gamma,
          };
          this.emit('video-params', s.video);
        } else if (!vp) s.video = null;
        break;
      }
      case 'video-codec':
        if (s.video) s.video.codec = typeof value === 'string' ? value : null;
        break;
      case 'hwdec-current':
        if (s.video) s.video.hwdec = typeof value === 'string' && value !== 'no' ? value : null;
        break;
      case 'container-fps':
        if (s.video && typeof value === 'number') s.video.fps = Math.round(value * 1000) / 1000;
        break;
      case 'eof-reached':
        if (value === true && !this.endedHandled && s.media) {
          this.endedHandled = true;
          void this.onEnded();
        }
        break;
      case 'audio-device':
        s.audioDevice = typeof value === 'string' ? value : null;
        break;
      case 'demuxer-cache-duration':
        s.bufferingSeconds = typeof value === 'number' ? Math.round(value * 10) / 10 : null;
        break;
      case 'paused-for-cache':
        if (value === true && s.status === 'playing') s.status = 'loading';
        else if (value === false && s.status === 'loading' && s.media) s.status = s.paused ? 'paused' : 'playing';
        break;
      default:
        break;
    }
    this.scheduleEmit(false);
  }

  private onEvent(evt: MpvEvent): void {
    if (evt.event === 'file-loaded') {
      this.endedHandled = false;
      this.patch({ status: this.stateValue.paused ? 'paused' : 'playing', error: null }, true);
      this.emit('file-loaded', this.state);
      if (this.pendingResume) {
        // Fallback for mpv builds that ignored the start= loadfile option.
        const { position } = this.pendingResume;
        this.pendingResume = null;
        void this.ipc
          ?.getOr<number>('time-pos', 0)
          .then((t) => (Math.abs(t - position) > 3 ? this.ipc?.command('seek', position, 'absolute') : undefined))
          .catch(() => undefined);
      }
    } else if (evt.event === 'end-file') {
      const reason = String(evt.reason ?? '');
      if (reason === 'error') {
        const msg = String(evt.file_error ?? 'unknown error');
        log.warn('playback error', { msg });
        this.patch({ status: 'error', error: `This file could not be played (${msg}).` }, true);
        this.emit('error-message', `This file could not be played (${msg}).`);
      }
    } else if (evt.event === 'shutdown') {
      this.expectedExit = this.expectedExit || this.disposed;
    }
  }

  private async onEnded(): Promise<void> {
    this.saveHistory(true);
    const s = this.settings.get();
    if (s.playback.autoplayNext && this.queueIndex + 1 < this.queue.length) {
      this.queueIndex++;
      await this.openQueued().catch((err) => log.error('autoplay next failed', err));
      return;
    }
    this.patch({ status: 'ended' }, true);
    this.emit('ended', this.state);
  }

  private saveHistory(ended: boolean): void {
    const s = this.stateValue;
    const id = s.media?.id;
    if (!id || s.media?.kind === 'photo') return;
    const duration = s.duration || 0;
    const position = ended ? duration : s.position;
    if (!ended && position < 1) return;
    const watched = ended || (duration > 0 && position / duration > 0.92);
    try {
      this.db.saveHistory(id, watched ? 0 : position, duration, watched, false);
      this.lastHistorySave = Date.now();
      this.emit('history');
    } catch (err) {
      log.warn('history save failed', err);
    }
  }

  private async openQueued(): Promise<void> {
    const id = this.queue[this.queueIndex];
    if (!id) return;
    await this.open({ mediaId: id, queue: undefined, resume: true });
  }

  /**
   * Open a library item (by id) or an internal path. The renderer and remote
   * can only reach this with library ids; paths are resolved from the DB.
   */
  async open(req: OpenRequest, startOverride?: number): Promise<void> {
    let filePath: string;
    let title = req.title ?? '';
    let kind: MediaKind = req.kind ?? 'video';
    let mediaId: string | null = null;
    if (req.mediaId) {
      const row = this.db.getMediaRow(req.mediaId);
      if (!row) throw new Error('Unknown media item');
      if (!fs.existsSync(row.path)) throw new Error('The file is no longer available. Is the drive connected?');
      filePath = row.path;
      title = row.title;
      kind = row.kind;
      mediaId = row.id;
    } else if (req.path) {
      filePath = req.path;
      title = title || path.basename(req.path);
    } else throw new Error('Nothing to open');
    if (kind === 'photo') throw new Error('Photos are shown by the NOVA viewer, not the video engine');

    if (req.queue && req.queue.length) {
      this.queue = req.queue.slice(0, 2000);
      const idx = mediaId ? this.queue.indexOf(mediaId) : -1;
      this.queueIndex = idx >= 0 ? idx : 0;
    } else if (req.queue === undefined && mediaId && !this.queue.includes(mediaId)) {
      this.queue = [mediaId];
      this.queueIndex = 0;
    } else if (mediaId) {
      this.queueIndex = Math.max(0, this.queue.indexOf(mediaId));
    }

    // Save progress of whatever was playing before switching.
    if (this.stateValue.media?.id && this.stateValue.media.id !== mediaId) this.saveHistory(false);

    let start: number | null = startOverride ?? null;
    if (start === null && mediaId && (req.resume ?? true) && this.settings.get().playback.resume) {
      const h = this.db.getHistory(mediaId);
      if (h && !h.watched && h.position > 15 && (h.duration === 0 || h.position < h.duration * 0.95)) start = h.position;
    }

    this.patch(
      {
        status: 'loading',
        media: { id: mediaId, title, kind, path: filePath },
        position: start ?? 0,
        duration: 0,
        error: null,
        tracks: [],
        video: null,
        queue: { index: this.queueIndex, length: this.queue.length },
      },
      true,
    );
    const ipc = await this.ensureEngine();
    if (mediaId) this.db.saveHistory(mediaId, start ?? 0, this.db.getHistory(mediaId)?.duration ?? 0, false, true);
    this.pendingResume = start && mediaId ? { mediaId, position: start } : null;
    this.endedHandled = false;
    await ipc.set('pause', false);
    try {
      await ipc.command(...loadfileCommand(filePath, start, this.mpvVersion));
    } catch (err) {
      // Older/newer syntax mismatch: retry without options and seek after load.
      log.warn('loadfile with options failed, retrying plain', err);
      await ipc.command('loadfile', filePath, 'replace');
    }
  }

  async command(cmd: PlayerCommand): Promise<void> {
    const ipc = this.client;
    if (!ipc) {
      if (cmd.type === 'stop') return;
      throw new Error('Nothing is playing');
    }
    const s = this.settings.get();
    switch (cmd.type) {
      case 'toggle':
        if (this.stateValue.status === 'ended') {
          await ipc.command('seek', 0, 'absolute');
          await ipc.set('pause', false);
          this.patch({ status: 'playing' }, true);
        } else await ipc.command('cycle', 'pause');
        break;
      case 'play':
        await ipc.set('pause', false);
        break;
      case 'pause':
        await ipc.set('pause', true);
        break;
      case 'stop':
        await this.stop();
        break;
      case 'seek': {
        const v = Number.isFinite(cmd.value) ? cmd.value : 0;
        if (cmd.mode === 'relative') await ipc.command('seek', Math.max(-3600, Math.min(3600, v)), 'relative');
        else if (cmd.mode === 'absolute') await ipc.command('seek', Math.max(0, v), 'absolute');
        else await ipc.command('seek', Math.max(0, Math.min(100, v)), 'absolute-percent');
        if (this.stateValue.status === 'ended') this.patch({ status: 'paused' });
        break;
      }
      case 'volume': {
        let vol = this.stateValue.volume;
        if (cmd.action === 'set') vol = cmd.value ?? vol;
        else vol += cmd.action === 'up' ? 5 : -5;
        vol = Math.max(0, Math.min(130, Math.round(vol)));
        await ipc.set('volume', vol);
        if (vol !== s.audio.volume) this.settings.update({ audio: { volume: vol } });
        break;
      }
      case 'mute':
        await ipc.set('mute', cmd.value ?? !this.stateValue.muted);
        break;
      case 'track':
        await ipc.set(cmd.kind === 'audio' ? 'aid' : 'sid', cmd.id === 'off' ? 'no' : cmd.id);
        break;
      case 'next':
        if (this.queueIndex + 1 < this.queue.length) {
          this.saveHistory(false);
          this.queueIndex++;
          await this.openQueued();
        }
        break;
      case 'previous':
        if (this.stateValue.position > 5 || this.queueIndex === 0) await ipc.command('seek', 0, 'absolute');
        else {
          this.saveHistory(false);
          this.queueIndex--;
          await this.openQueued();
        }
        break;
      case 'subScale':
        await ipc.set('sub-scale', Math.max(0.5, Math.min(2.5, cmd.value)));
        break;
      case 'audioDevice':
        await ipc.set('audio-device', cmd.name);
        this.settings.update({ audio: { device: cmd.name } });
        break;
    }
  }

  async stop(): Promise<void> {
    this.saveHistory(false);
    if (this.ipc?.connected) await this.ipc.command('stop').catch(() => undefined);
    this.pendingResume = null;
    this.patch({ status: 'idle', media: null, position: 0, duration: 0, tracks: [], video: null, error: null }, true);
  }

  /** Window screenshot including all NOVA Vision processing (used by self-test). */
  async screenshot(file: string): Promise<void> {
    const ipc = await this.ensureEngine();
    await ipc.command('screenshot-to-file', file, 'window');
  }

  async listAudioDevices(): Promise<Array<{ name: string; description: string }>> {
    const ipc = this.client;
    if (!ipc) return [];
    const list = await ipc.getOr<Array<{ name: string; description: string }>>('audio-device-list', []);
    return list.map((d) => ({ name: d.name, description: d.description }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.saveHistory(false);
    this.expectedExit = true;
    if (this.ipc?.connected) await this.ipc.command('quit').catch(() => undefined);
    this.ipc?.close();
    const proc = this.proc;
    if (proc && proc.exitCode === null) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          proc.kill();
          r();
        }, 1500);
        proc.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  /** Restart the engine (e.g. after the video window moved to another display). */
  async restartEngine(): Promise<void> {
    const media = this.stateValue.media;
    const pos = this.stateValue.position;
    const wasPaused = this.stateValue.paused;
    this.expectedExit = true;
    if (this.ipc?.connected) await this.ipc.command('quit').catch(() => undefined);
    this.ipc?.close();
    this.ipc = null;
    await new Promise((r) => setTimeout(r, 300));
    this.expectedExit = false;
    if (media) {
      await this.open({ mediaId: media.id ?? undefined, path: media.id ? undefined : media.path, title: media.title, kind: media.kind, resume: false }, pos);
      if (wasPaused) await this.ipc?.set('pause', true);
    }
  }
}

function mapTracks(value: unknown): PlayerTrack[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      id: Number(t.id),
      type: t.type === 'sub' ? 'sub' : t.type === 'audio' ? 'audio' : 'video',
      title: typeof t.title === 'string' ? t.title : null,
      lang: typeof t.lang === 'string' ? t.lang : null,
      codec: typeof t.codec === 'string' ? t.codec : null,
      default: Boolean(t.default),
      forced: Boolean(t.forced),
      external: Boolean(t.external),
      selected: Boolean(t.selected),
      channels: typeof t['demux-channel-count'] === 'number' ? (t['demux-channel-count'] as number) : null,
    }));
}
