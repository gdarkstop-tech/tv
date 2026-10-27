import path from 'node:path';
import type { PictureAdjustments, ProcessingPriority } from '../../shared/types';

// Pure translation of NOVA picture settings into mpv properties.
// Kept free of Electron/IO so it can be unit-tested exhaustively.

export interface VisionContext {
  shaderDir: string;
  /** True when mpv runs vo=gpu-next and accepted a parametrised user shader. */
  shadersSupported: boolean;
  /** Display reports HDR and the OS has HDR output enabled (verified). */
  hdrPassthrough: boolean;
  hardwareDecoding: 'auto' | 'off';
  /** Gaming mode: lowest latency, no optional processing. */
  lowLatency: boolean;
}

export type MpvValue = string | number | boolean;

export interface MpvVisionState {
  properties: Array<[string, MpvValue]>;
  shaders: string[];
  shaderOpts: Record<string, string>;
  vf: string;
  hwdec: string;
  scaler: string;
}

export const MAX_DEGRADE_LEVEL = 4;

export const SHADER_FILES = {
  sharpen: 'nova-sharpen.glsl',
  whiteBalance: 'nova-white-balance.glsl',
} as const;

const NOISE_REDUCTION: Record<Exclude<PictureAdjustments['noiseReduction'], 'off'>, string> = {
  // hqdn3d luma_spatial:chroma_spatial:luma_tmp:chroma_tmp
  low: '2:1.5:3:2.25',
  medium: '4:3:6:4.5',
  high: '7:5.25:10:7.5',
};

const SCALERS: Record<ProcessingPriority, { scale: string; cscale: string; dscale: string }> = {
  quality: { scale: 'ewa_lanczossharp', cscale: 'lanczos', dscale: 'mitchell' },
  balanced: { scale: 'spline36', cscale: 'spline36', dscale: 'hermite' },
  smoothness: { scale: 'bilinear', cscale: 'bilinear', dscale: 'bilinear' },
};

const GAMMA_TO_TRC: Record<PictureAdjustments['sdrGamma'], string> = {
  auto: 'auto',
  '2.2': 'gamma2.2',
  '2.4': 'bt.1886',
  srgb: 'srgb',
};

export interface DegradeResult {
  adjustments: PictureAdjustments;
  priority: ProcessingPriority;
  reasons: string[];
}

const PRIORITY_ORDER: ProcessingPriority[] = ['quality', 'balanced', 'smoothness'];

function atMost(p: ProcessingPriority, limit: ProcessingPriority): ProcessingPriority {
  return PRIORITY_ORDER.indexOf(p) >= PRIORITY_ORDER.indexOf(limit) ? p : limit;
}

/**
 * Progressively reduce processing cost. Level 0 = as configured.
 * 1: drop CPU noise reduction and motion interpolation
 * 2: drop sharpening, dynamic HDR peak detection; cap priority at balanced
 * 3: fast scalers (smoothness), no debanding
 * 4: additionally allow mpv to drop frames at the decoder (handled by caller)
 */
export function degrade(adj: PictureAdjustments, priority: ProcessingPriority, level: number): DegradeResult {
  const out: PictureAdjustments = { ...adj };
  let p = priority;
  const reasons: string[] = [];
  if (level >= 1) {
    if (out.noiseReduction !== 'off') reasons.push('noise reduction off');
    if (out.motionSmoothing) reasons.push('motion smoothing off');
    out.noiseReduction = 'off';
    out.motionSmoothing = false;
  }
  if (level >= 2) {
    if (out.sharpness > 0) reasons.push('sharpening off');
    if (out.hdrPeakDetection) reasons.push('HDR peak detection off');
    if (p === 'quality') reasons.push('scaling quality reduced to balanced');
    out.sharpness = 0;
    out.hdrPeakDetection = false;
    p = atMost(p, 'balanced');
  }
  if (level >= 3) {
    if (p !== 'smoothness') reasons.push('fast scaling');
    if (out.deband) reasons.push('debanding off');
    out.deband = false;
    p = 'smoothness';
  }
  if (level >= 4) reasons.push('decoder frame dropping allowed');
  return { adjustments: out, priority: p, reasons };
}

export function buildVisionState(
  adj: PictureAdjustments,
  priority: ProcessingPriority,
  ctx: VisionContext,
  degradeLevel = 0,
): MpvVisionState {
  const effPriority: ProcessingPriority = ctx.lowLatency ? 'smoothness' : priority;
  const sc = SCALERS[effPriority];
  const props: Array<[string, MpvValue]> = [];

  // Signal-level adjustments (applied in the renderer's colour pipeline, cheap).
  props.push(['brightness', adj.brightness]);
  props.push(['contrast', adj.contrast]);
  props.push(['saturation', adj.saturation]);
  props.push(['gamma', adj.gamma]);
  props.push(['hue', adj.hue]);

  // Scaling.
  props.push(['scale', sc.scale]);
  props.push(['cscale', sc.cscale]);
  props.push(['dscale', sc.dscale]);
  const fast = effPriority === 'smoothness';
  props.push(['correct-downscaling', !fast]);
  props.push(['linear-downscaling', !fast]);
  props.push(['sigmoid-upscaling', !fast]);

  props.push(['deband', adj.deband && !ctx.lowLatency]);

  // Output transfer / levels. With verified HDR passthrough we let mpv signal
  // the content's colourspace to the OS instead of tone mapping to SDR.
  if (ctx.hdrPassthrough) {
    props.push(['target-colorspace-hint', true]);
    props.push(['target-trc', 'auto']);
  } else {
    props.push(['target-colorspace-hint', false]);
    props.push(['target-trc', GAMMA_TO_TRC[adj.sdrGamma]]);
  }
  props.push(['tone-mapping', adj.toneMapping]);
  props.push(['hdr-compute-peak', adj.hdrPeakDetection && !fast ? 'yes' : 'no']);
  props.push(['video-output-levels', adj.outputLevels]);

  // Motion.
  if (adj.motionSmoothing && !ctx.lowLatency) {
    props.push(['video-sync', 'display-resample']);
    props.push(['interpolation', true]);
    props.push(['tscale', 'oversample']);
  } else {
    props.push(['video-sync', 'audio']);
    props.push(['interpolation', false]);
  }
  props.push(['video-latency-hacks', ctx.lowLatency]);
  props.push(['framedrop', degradeLevel >= MAX_DEGRADE_LEVEL ? 'decoder+vo' : 'vo']);

  // User shaders (GPU). Only when the renderer supports parametrised shaders.
  const shaders: string[] = [];
  const shaderOpts: Record<string, string> = {};
  if (ctx.shadersSupported && !ctx.lowLatency) {
    if (adj.sharpness > 0) {
      shaders.push(path.join(ctx.shaderDir, SHADER_FILES.sharpen));
      shaderOpts.nova_sharp = (adj.sharpness / 10).toFixed(2);
    }
    if (adj.colorTemperature !== 0) {
      shaders.push(path.join(ctx.shaderDir, SHADER_FILES.whiteBalance));
      shaderOpts.nova_temp = (adj.colorTemperature / 10).toFixed(2);
    }
  }

  // CPU noise reduction needs decoded frames in system memory, so switch the
  // hardware decoder to a copy-back mode while it is enabled.
  let vf = '';
  if (adj.noiseReduction !== 'off' && !ctx.lowLatency) {
    vf = `@novanr:lavfi=[hqdn3d=${NOISE_REDUCTION[adj.noiseReduction]}]`;
  }
  let hwdec = 'no';
  if (ctx.hardwareDecoding === 'auto') hwdec = vf ? 'auto-copy-safe' : 'auto-safe';

  return { properties: props, shaders, shaderOpts, vf, hwdec, scaler: sc.scale };
}

export function shaderOptsString(opts: Record<string, string>): string {
  return Object.entries(opts)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}
