// Adaptive quality controller: decides when to reduce NOVA Vision processing
// because playback is dropping frames. Pure state machine for testability.

export interface AdaptiveObservation {
  at: number;
  playing: boolean;
  droppedTotal: number;
  decoderDroppedTotal: number;
  systemCpuPercent: number;
  softwareDecode: boolean;
}

export interface AdaptiveConfig {
  dropsPerSecondThreshold: number;
  consecutiveBadSamples: number;
  warmupMs: number;
  cooldownMs: number;
  maxLevel: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  dropsPerSecondThreshold: 1.0,
  consecutiveBadSamples: 2,
  warmupMs: 4000,
  cooldownMs: 6000,
  maxLevel: 4,
};

export class AdaptiveController {
  private last: AdaptiveObservation | null = null;
  private bad = 0;
  private lastStepAt = 0;
  private warmupUntil = 0;
  level = 0;
  lastDropsPerSecond = 0;

  constructor(private readonly cfg: AdaptiveConfig = DEFAULT_ADAPTIVE) {}

  /** Call on new file / seek: counters reset and a warm-up period starts. */
  reset(now: number, keepLevel = false): void {
    this.last = null;
    this.bad = 0;
    this.warmupUntil = now + this.cfg.warmupMs;
    if (!keepLevel) this.level = 0;
  }

  /** Returns the new level if processing should be reduced, else null. */
  observe(o: AdaptiveObservation): { level: number; reason: string } | null {
    const prev = this.last;
    this.last = o;
    if (!o.playing || !prev || o.at < this.warmupUntil) {
      this.lastDropsPerSecond = 0;
      return null;
    }
    const dt = (o.at - prev.at) / 1000;
    if (dt <= 0) return null;
    const drops = Math.max(0, o.droppedTotal - prev.droppedTotal) + Math.max(0, o.decoderDroppedTotal - prev.decoderDroppedTotal);
    const rate = drops / dt;
    this.lastDropsPerSecond = Math.round(rate * 100) / 100;
    const cpuStarved = o.softwareDecode && o.systemCpuPercent > 95 && rate > 0.3;
    if (rate > this.cfg.dropsPerSecondThreshold || cpuStarved) this.bad++;
    else this.bad = 0;
    if (this.bad < this.cfg.consecutiveBadSamples) return null;
    if (this.level >= this.cfg.maxLevel) return null;
    if (o.at - this.lastStepAt < this.cfg.cooldownMs) return null;
    this.level++;
    this.lastStepAt = o.at;
    this.bad = 0;
    // New settings need a moment to take effect before judging again.
    this.warmupUntil = o.at + this.cfg.warmupMs;
    const why = cpuStarved ? `CPU at ${Math.round(o.systemCpuPercent)}% with software decoding` : `${this.lastDropsPerSecond} dropped frames/s`;
    return { level: this.level, reason: `Playback was unstable (${why})` };
  }
}
