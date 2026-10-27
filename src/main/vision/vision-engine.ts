import { EventEmitter } from 'node:events';
import { adjustmentsForMode } from '../../shared/picture';
import type { DisplayInfo, GpuInfo, PictureMode, VisionStatus } from '../../shared/types';
import { logger } from '../log';
import { resourcePath } from '../paths';
import type { MpvIpcClient } from '../player/mpv-ipc';
import type { PlayerService } from '../player/player-service';
import type { SettingsStore } from '../settings-store';
import { decideAuto, gpuTier } from './auto';
import { buildVisionState, degrade, MAX_DEGRADE_LEVEL, shaderOptsString, type MpvValue } from './mapping';

const log = logger('vision');

/**
 * NOVA Vision Engine: turns picture settings into live mpv configuration,
 * handles Auto mode and adaptive degradation requested by the Performance
 * Manager. All processing is software video processing inside NOVA; it never
 * changes the television's own settings.
 */
export class VisionEngine extends EventEmitter {
  private applied = new Map<string, string>();
  private appliedShaders: string[] = [];
  private appliedShaderOpts = '';
  private appliedVf = '';
  private appliedHwdec = '';
  private unsupported = new Set<string>();
  private shadersSupported: boolean | null = null;
  private degradeLevel = 0;
  private degradeReason: string | null = null;
  private autoReason: string | null = null;
  private applying: Promise<void> = Promise.resolve();
  private gpus: GpuInfo[] = [];

  constructor(
    private readonly player: PlayerService,
    private readonly settings: SettingsStore,
    private readonly display: () => DisplayInfo | null,
  ) {
    super();
    player.on('engine-ready', (ipc: MpvIpcClient) => {
      this.applied.clear();
      this.appliedShaders = [];
      this.appliedShaderOpts = '';
      this.appliedVf = '';
      this.appliedHwdec = '';
      void this.detectShaderSupport(ipc).then(() => this.apply());
    });
    player.on('file-loaded', () => {
      if (this.degradeLevel > 0) this.setDegrade(0, null, false);
      void this.apply();
    });
    player.on('video-params', () => {
      if (this.settings.get().picture.mode === 'auto') void this.apply();
    });
    settings.on('change', (next, prev) => {
      if (JSON.stringify(next.picture) !== JSON.stringify(prev.picture) || next.playback.hardwareDecoding !== prev.playback.hardwareDecoding) {
        void this.apply();
      }
    });
  }

  setGpus(gpus: GpuInfo[]): void {
    this.gpus = gpus;
  }

  private async detectShaderSupport(ipc: MpvIpcClient): Promise<void> {
    const vo = await ipc.getOr<string>('current-vo', '');
    const v = this.player.version;
    const newEnough = !v || v[0] > 0 || v[1] >= 35;
    // gpu-next (libplacebo) supports //!PARAM shader parameters; vo=gpu does not.
    this.shadersSupported = vo === 'gpu-next' && newEnough;
    log.info('renderer', { vo, shadersSupported: this.shadersSupported });
  }

  private effective(): { mode: Exclude<PictureMode, 'auto'>; priority: VisionStatus['effectivePriority'] } {
    const s = this.settings.get();
    if (s.picture.mode !== 'auto') {
      this.autoReason = null;
      return { mode: s.picture.mode, priority: s.picture.mode === 'gaming' ? 'smoothness' : s.picture.priority };
    }
    const st = this.player.state;
    const d = this.display();
    const tier = gpuTier(this.gpus);
    const decision = decideAuto({
      tier: tier.tier,
      gpuName: tier.name,
      source: st.video ? { width: st.video.width, height: st.video.height, fps: st.video.fps, hdr: st.video.hdr, hardwareDecoded: Boolean(st.video.hwdec) } : null,
      output: d ? { width: d.currentMode.width, height: d.currentMode.height, refreshHz: d.currentMode.refreshHz } : null,
    });
    this.autoReason = decision.reason;
    return { mode: decision.mode, priority: decision.priority };
  }

  private hdrPassthrough(): boolean {
    const d = this.display();
    // Only Windows' d3d11 path signals HDR metadata to the OS reliably.
    return process.platform === 'win32' && Boolean(d?.hdr.osHdrEnabled.value) && d?.hdr.osHdrEnabled.verification !== 'unknown';
  }

  /** Re-apply the current picture configuration to mpv (serialised). */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch((err) => log.warn('apply failed', err));
    return this.applying;
  }

  private async applyNow(): Promise<void> {
    const ipc = this.player.client;
    if (!ipc) {
      this.emit('status', this.status());
      return;
    }
    const s = this.settings.get();
    const eff = this.effective();
    const base = adjustmentsForMode(eff.mode, s.picture.custom);
    const lowLatency = eff.mode === 'gaming';
    const d = degrade(base, eff.priority, this.degradeLevel);
    const state = buildVisionState(d.adjustments, d.priority, {
      shaderDir: resourcePath('shaders'),
      shadersSupported: this.shadersSupported === true,
      hdrPassthrough: this.hdrPassthrough(),
      hardwareDecoding: s.playback.hardwareDecoding,
      lowLatency,
    }, this.degradeLevel);

    for (const [name, value] of state.properties) await this.setProp(ipc, name, value);

    if (state.hwdec !== this.appliedHwdec) {
      await this.setProp(ipc, 'hwdec', state.hwdec);
      this.appliedHwdec = state.hwdec;
    }
    if (state.vf !== this.appliedVf) {
      try {
        await ipc.set('vf', state.vf);
        this.appliedVf = state.vf;
        this.unsupported.delete('vf');
      } catch (err) {
        this.unsupported.add('vf');
        log.warn('noise reduction filter rejected', err);
      }
    }
    const shaderKey = state.shaders.join('|');
    if (shaderKey !== this.appliedShaders.join('|')) {
      try {
        await ipc.command('change-list', 'glsl-shaders', 'clr', '');
        for (const sh of state.shaders) await ipc.command('change-list', 'glsl-shaders', 'append', sh);
        this.appliedShaders = state.shaders;
        this.unsupported.delete('glsl-shaders');
      } catch (err) {
        this.unsupported.add('glsl-shaders');
        log.warn('shader load failed', err);
      }
    }
    const opts = shaderOptsString(state.shaderOpts);
    if (opts !== this.appliedShaderOpts) {
      try {
        await ipc.set('glsl-shader-opts', opts);
        this.appliedShaderOpts = opts;
      } catch (err) {
        this.unsupported.add('glsl-shader-opts');
        log.warn('shader options rejected', err);
      }
    }
    this.emit('status', this.status());
  }

  private async setProp(ipc: MpvIpcClient, name: string, value: MpvValue): Promise<void> {
    const key = String(value);
    if (this.applied.get(name) === key) return;
    try {
      await ipc.set(name, value);
      this.applied.set(name, key);
      this.unsupported.delete(name);
    } catch (err) {
      if (!this.unsupported.has(name)) log.warn(`mpv rejected ${name}=${key}`, err);
      this.unsupported.add(name);
      this.applied.set(name, key);
    }
  }

  get level(): number {
    return this.degradeLevel;
  }

  setDegrade(level: number, reason: string | null, apply = true): void {
    const next = Math.max(0, Math.min(MAX_DEGRADE_LEVEL, level));
    if (next === this.degradeLevel) return;
    this.degradeLevel = next;
    this.degradeReason = reason;
    log.info('degrade level', { level: next, reason });
    if (apply) void this.apply();
    else this.emit('status', this.status());
  }

  status(): VisionStatus {
    const s = this.settings.get();
    const eff = this.effective();
    const base = adjustmentsForMode(eff.mode, s.picture.custom);
    const d = degrade(base, eff.priority, this.degradeLevel);
    const lowLatency = eff.mode === 'gaming';
    const state = buildVisionState(d.adjustments, d.priority, {
      shaderDir: '',
      shadersSupported: this.shadersSupported === true,
      hdrPassthrough: this.hdrPassthrough(),
      hardwareDecoding: s.playback.hardwareDecoding,
      lowLatency,
    }, this.degradeLevel);
    const display = this.display();
    const st = this.player.state;
    const src = st.video;
    let scaling: string | null = null;
    if (src && display) {
      const outW = display.currentMode.width;
      const outH = display.currentMode.height;
      const fitScale = Math.min(outW / src.width, outH / src.height);
      const tw = Math.round(src.width * fitScale);
      const th = Math.round(src.height * fitScale);
      if (Math.abs(fitScale - 1) < 0.01) scaling = `${src.width}x${src.height} shown 1:1 (no scaling)`;
      else if (fitScale > 1)
        scaling = `${src.width}x${src.height} upscaled to ${tw}x${th} with ${state.scaler}. Software upscaling improves smoothness of edges but cannot add real detail or exceed the display's ${outW}x${outH} resolution.`;
      else scaling = `${src.width}x${src.height} downscaled to ${tw}x${th} to fit the ${outW}x${outH} display.`;
    }
    return {
      requestedMode: s.picture.mode,
      effectiveMode: eff.mode,
      requestedPriority: s.picture.priority,
      effectivePriority: d.priority,
      autoReason: this.autoReason,
      adjustments: d.adjustments,
      degradeLevel: this.degradeLevel,
      degradeReason: this.degradeLevel > 0 ? [this.degradeReason, ...d.reasons].filter(Boolean).join('; ') : null,
      scaler: state.scaler,
      shadersActive: state.shaders.map((p) => p.split(/[\\/]/).pop() ?? p),
      shaderSupport: {
        value: this.shadersSupported === true,
        verification: this.shadersSupported === null ? 'unknown' : 'verified',
        source: this.shadersSupported === null ? 'video engine not started yet' : 'mpv current-vo',
        note: this.shadersSupported === false ? 'Sharpness and colour temperature need mpv vo=gpu-next (mpv 0.35+).' : undefined,
      },
      unsupportedProperties: [...this.unsupported],
      output: display
        ? { displayWidth: display.currentMode.width, displayHeight: display.currentMode.height, refreshHz: display.currentMode.refreshHz, hdrPassthrough: this.hdrPassthrough() }
        : null,
      source: src ? { width: src.width, height: src.height, fps: src.fps, hdr: src.hdr, transfer: src.transfer, primaries: src.primaries } : null,
      scalingDescription: scaling,
    };
  }
}
