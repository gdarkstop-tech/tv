import { app } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import type { PerformanceSample } from '../../shared/types';
import { locateTool } from '../hardware/tools';
import { windowsHelper } from '../hardware/windows-helper';
import { logger } from '../log';
import type { PlayerService } from '../player/player-service';
import type { SettingsStore } from '../settings-store';
import { run } from '../util/exec';
import type { VisionEngine } from '../vision/vision-engine';
import { AdaptiveController } from './adaptive';

const log = logger('perf');

/**
 * Measures real resource usage and playback health, and asks the Vision
 * Engine to shed processing when frames drop. Sampling runs only while
 * something is playing or a diagnostics view is open.
 */
export class PerformanceManager extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private prevCpu = os.cpus();
  private prevProc: { at: number; cpuSeconds: number } | null = null;
  private gpuCache: { at: number; value: PerformanceSample['gpu'] } | null = null;
  private watchers = 0;
  private adaptive = new AdaptiveController();
  private latest: PerformanceSample | null = null;
  private sampling = false;

  constructor(
    private readonly player: PlayerService,
    private readonly vision: VisionEngine,
    private readonly settings: SettingsStore,
  ) {
    super();
    player.on('file-loaded', () => this.adaptive.reset(Date.now()));
    player.on('state', (s) => {
      const active = s.status === 'playing' || s.status === 'paused' || s.status === 'loading';
      this.ensureTimer(active || this.watchers > 0);
    });
  }

  latestSample(): PerformanceSample | null {
    return this.latest;
  }

  /** Called when a diagnostics view opens (+1) or closes (-1). */
  watch(delta: 1 | -1): void {
    this.watchers = Math.max(0, this.watchers + delta);
    const st = this.player.state.status;
    this.ensureTimer(this.watchers > 0 || st === 'playing' || st === 'paused');
  }

  notifySeek(): void {
    this.adaptive.reset(Date.now(), true);
  }

  private ensureTimer(on: boolean): void {
    if (on && !this.timer) {
      this.timer = setInterval(() => void this.tick(), 2000);
      void this.tick();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    this.ensureTimer(false);
  }

  private systemCpu(): number {
    const now = os.cpus();
    let idle = 0;
    let total = 0;
    now.forEach((c, i) => {
      const p = this.prevCpu[i];
      if (!p) return;
      const t = (x: os.CpuInfo) => x.times.user + x.times.nice + x.times.sys + x.times.irq + x.times.idle;
      total += t(c) - t(p);
      idle += c.times.idle - p.times.idle;
    });
    this.prevCpu = now;
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  }

  private async playerProcess(pid: number | null): Promise<{ cpu: number | null; memMB: number | null }> {
    if (!pid) return { cpu: null, memMB: null };
    let cpuSeconds: number | null = null;
    let memMB: number | null = null;
    try {
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        cpuSeconds = (Number(fields[11]) + Number(fields[12])) / 100;
        memMB = Math.round((Number(fields[21]) * 4096) / 1048576);
      } else if (process.platform === 'win32') {
        const r = await windowsHelper.call<{ cpuSeconds: number; workingSetBytes: number }>('processStats', { pid }, 5000);
        cpuSeconds = r.cpuSeconds;
        memMB = Math.round(r.workingSetBytes / 1048576);
      } else if (process.platform === 'darwin') {
        const r = await run('/bin/ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { timeoutMs: 3000 });
        const [cpu, rss] = r.stdout.trim().split(/\s+/).map(Number);
        return { cpu: cpu ?? null, memMB: rss ? Math.round(rss / 1024) : null };
      }
    } catch {
      return { cpu: null, memMB: null };
    }
    if (cpuSeconds === null) return { cpu: null, memMB };
    const now = Date.now();
    const prev = this.prevProc;
    this.prevProc = { at: now, cpuSeconds };
    if (!prev) return { cpu: null, memMB };
    const pct = ((cpuSeconds - prev.cpuSeconds) / ((now - prev.at) / 1000) / os.cpus().length) * 100;
    return { cpu: Math.max(0, Math.round(pct * 10) / 10), memMB };
  }

  private async gpu(): Promise<PerformanceSample['gpu']> {
    if (this.gpuCache && Date.now() - this.gpuCache.at < 5000) return this.gpuCache.value;
    let value: PerformanceSample['gpu'] = null;
    try {
      if (process.platform === 'win32') {
        const u = await windowsHelper.call<{ Available: boolean; ThreeD: number; VideoDecode: number; Error: string | null }>('gpuUsage', {}, 8000);
        if (u.Available) value = { utilizationPercent: u.ThreeD, memoryUsedMB: null, source: `Windows GPU counters (video decode engine ${u.VideoDecode}%)` };
      }
      if (!value) {
        const smi = locateTool('nvidia-smi');
        if (smi) {
          const r = await run(smi, ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], { timeoutMs: 4000 });
          const [u, m] = r.stdout.split('\n')[0]?.split(',').map((x) => Number(x.trim())) ?? [];
          if (r.ok && Number.isFinite(u)) value = { utilizationPercent: u ?? null, memoryUsedMB: Number.isFinite(m) ? (m ?? null) : null, source: 'nvidia-smi' };
        }
      }
      if (!value && process.platform === 'linux') {
        for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
          const f = `/sys/class/drm/${card}/device/gpu_busy_percent`;
          if (fs.existsSync(f)) {
            value = { utilizationPercent: Number(fs.readFileSync(f, 'utf8').trim()), memoryUsedMB: null, source: 'amdgpu sysfs' };
            break;
          }
        }
      }
    } catch (err) {
      log.debug('gpu sample failed', err);
    }
    this.gpuCache = { at: Date.now(), value };
    return value;
  }

  private async tick(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const sample = await this.sample();
      this.latest = sample;
      this.emit('sample', sample);
      const s = this.settings.get();
      if (sample.playback && s.picture.adaptive) {
        const step = this.adaptive.observe({
          at: sample.at,
          playing: this.player.state.status === 'playing',
          droppedTotal: sample.playback.droppedFrames,
          decoderDroppedTotal: sample.playback.decoderDroppedFrames,
          systemCpuPercent: sample.systemCpuPercent,
          softwareDecode: !sample.playback.hwdec,
        });
        if (step) {
          this.vision.setDegrade(step.level, step.reason);
          this.emit('degraded', step);
        }
      }
    } catch (err) {
      log.warn('sample failed', err);
    } finally {
      this.sampling = false;
    }
  }

  async sample(): Promise<PerformanceSample> {
    const metrics = app.getAppMetrics();
    const appMem = metrics.reduce((a, m) => a + (m.memory?.workingSetSize ?? 0), 0) / 1024;
    const appCpu = metrics.reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0) / Math.max(1, os.cpus().length);
    const proc = await this.playerProcess(this.player.pid);
    const ipc = this.player.client;
    let playback: PerformanceSample['playback'] = null;
    if (ipc && this.player.state.media) {
      const [dropped, decDropped, delayed, est, cont, disp, hwdec, avsync] = await Promise.all([
        ipc.getOr<number>('frame-drop-count', 0),
        ipc.getOr<number>('decoder-frame-drop-count', 0),
        ipc.getOr<number>('vo-delayed-frame-count', 0),
        ipc.getOr<number | null>('estimated-vf-fps', null),
        ipc.getOr<number | null>('container-fps', null),
        ipc.getOr<number | null>('display-fps', null),
        ipc.getOr<string | null>('hwdec-current', null),
        ipc.getOr<number | null>('avsync', null),
      ]);
      playback = {
        droppedFrames: dropped,
        decoderDroppedFrames: decDropped,
        delayedFrames: delayed,
        estimatedFps: est !== null ? Math.round(est * 100) / 100 : null,
        containerFps: cont,
        displayFps: disp !== null ? Math.round(disp * 100) / 100 : null,
        dropsPerSecond: this.adaptive.lastDropsPerSecond,
        hwdec: hwdec && hwdec !== 'no' ? hwdec : null,
        avsync: avsync !== null ? Math.round(avsync * 1000) / 1000 : null,
      };
    }
    return {
      at: Date.now(),
      systemCpuPercent: this.systemCpu(),
      systemMemoryUsedMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
      systemMemoryTotalMB: Math.round(os.totalmem() / 1048576),
      appMemoryMB: Math.round(appMem),
      appCpuPercent: Math.round(appCpu * 10) / 10,
      playerCpuPercent: proc.cpu,
      playerMemoryMB: proc.memMB,
      gpu: await this.gpu(),
      playback,
      degradeLevel: this.vision.level,
    };
  }
}
