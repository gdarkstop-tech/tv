import type { GpuInfo, ProcessingPriority } from '../../shared/types';

// Auto picture mode: chooses a picture preset and processing priority from
// the GPU class, the source video and the output display. Pure and testable.

export type GpuTier = 'high' | 'mid' | 'low' | 'unknown';

export function gpuTier(gpus: GpuInfo[]): { tier: GpuTier; name: string | null } {
  const active = gpus.find((g) => g.active) ?? gpus[0];
  if (!active) return { tier: 'unknown', name: null };
  const name = `${active.vendor} ${active.name}`;
  const n = name.toLowerCase();
  if (/virtual|basic display|swiftshader|llvmpipe|software|vmware|virtio|qemu/.test(n)) return { tier: 'low', name };
  if (/nvidia/.test(n)) return { tier: /\bmx\s?\d|geforce\s?(9|gt\s?[0-9])/.test(n) ? 'mid' : 'high', name };
  if (/apple/.test(n)) return { tier: 'high', name };
  if (/radeon\s?(rx|pro)|radeon\s?[0-9]{4}\s?xt/.test(n)) return { tier: 'high', name };
  if (/amd|radeon/.test(n)) return { tier: 'mid', name };
  if (/intel/.test(n)) {
    if (/\barc\b/.test(n)) return { tier: 'high', name };
    if (/iris|xe/.test(n)) return { tier: 'mid', name };
    return { tier: 'low', name };
  }
  return { tier: 'unknown', name };
}

export interface AutoInput {
  tier: GpuTier;
  gpuName: string | null;
  source: { width: number; height: number; fps: number; hdr: boolean; hardwareDecoded: boolean } | null;
  output: { width: number; height: number; refreshHz: number } | null;
}

export interface AutoDecision {
  mode: 'standard' | 'cinema';
  priority: ProcessingPriority;
  reason: string;
}

export function decideAuto(i: AutoInput): AutoDecision {
  const mode: AutoDecision['mode'] = i.source?.hdr ? 'cinema' : 'standard';
  const outPixels = i.output ? i.output.width * i.output.height : 1920 * 1080;
  const out4k = outPixels >= 3840 * 2160 * 0.9;
  const srcRate = i.source ? i.source.width * i.source.height * Math.max(i.source.fps || 24, 1) : 1920 * 1080 * 24;
  const heavySource = srcRate > 1920 * 1080 * 30 * 1.05;
  const softwareDecode = i.source ? !i.source.hardwareDecoded : false;

  let priority: ProcessingPriority;
  switch (i.tier) {
    case 'high':
      priority = out4k && heavySource ? 'balanced' : 'quality';
      break;
    case 'mid':
      priority = out4k ? (heavySource ? 'smoothness' : 'balanced') : heavySource ? 'balanced' : 'quality';
      break;
    case 'low':
      priority = out4k || (heavySource && softwareDecode) ? 'smoothness' : 'balanced';
      break;
    default:
      priority = 'balanced';
  }
  if (softwareDecode && heavySource && priority === 'quality') priority = 'balanced';

  const parts: string[] = [];
  parts.push(i.gpuName ? `${i.gpuName} (${i.tier} tier)` : 'GPU class unknown');
  if (i.output) parts.push(`output ${i.output.width}x${i.output.height}@${Math.round(i.output.refreshHz)}Hz`);
  if (i.source) {
    parts.push(`source ${i.source.width}x${i.source.height}@${Math.round(i.source.fps * 100) / 100}${i.source.hdr ? ' HDR' : ''}`);
    if (softwareDecode) parts.push('software decoding');
  }
  if (i.source?.hdr) parts.push('HDR content → Cinema (reference tone mapping)');
  return { mode, priority, reason: parts.join(' · ') };
}
