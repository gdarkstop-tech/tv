import type { PictureAdjustments, PictureMode, ProcessingPriority } from './types';

// Picture presets for the NOVA Vision Engine. All presets deliberately stay
// close to neutral: the goal is an accurate, pleasant image, not an
// over-processed showroom look. Values use the NOVA scales documented on
// PictureAdjustments (they are mapped to mpv properties in main/vision).

export const NEUTRAL_ADJUSTMENTS: PictureAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 'off',
  deband: true,
  colorTemperature: 0,
  sdrGamma: 'auto',
  toneMapping: 'auto',
  hdrPeakDetection: true,
  motionSmoothing: false,
  outputLevels: 'auto',
};

export type PresetMode = Exclude<PictureMode, 'custom' | 'auto'>;

export const PICTURE_PRESETS: Record<PresetMode, PictureAdjustments> = {
  // Balanced everyday viewing: neutral colour, mild debanding.
  standard: { ...NEUTRAL_ADJUSTMENTS },
  // Accurate, cinematic: BT.1886 (gamma 2.4) for dim rooms, reference tone mapping.
  cinema: {
    ...NEUTRAL_ADJUSTMENTS,
    sdrGamma: '2.4',
    toneMapping: 'bt.2390',
  },
  // Stronger presentation for bright rooms. Kept modest so highlights and
  // skin tones do not clip: contrast/saturation increases are small and the
  // white-balance shader normalises gains so it cannot clip highlights.
  vivid: {
    ...NEUTRAL_ADJUSTMENTS,
    contrast: 6,
    saturation: 14,
    sharpness: 3,
    colorTemperature: 2,
    sdrGamma: '2.2',
  },
  // Lowest latency: no optional processing at all.
  gaming: {
    ...NEUTRAL_ADJUSTMENTS,
    deband: false,
    hdrPeakDetection: false,
  },
};

export const PICTURE_MODES: PictureMode[] = ['auto', 'standard', 'cinema', 'vivid', 'gaming', 'custom'];
export const PRIORITIES: ProcessingPriority[] = ['quality', 'balanced', 'smoothness'];

export const ADJUSTMENT_RANGES = {
  brightness: { min: -30, max: 30, step: 1 },
  contrast: { min: -30, max: 30, step: 1 },
  saturation: { min: -50, max: 50, step: 1 },
  gamma: { min: -30, max: 30, step: 1 },
  hue: { min: -30, max: 30, step: 1 },
  sharpness: { min: 0, max: 10, step: 1 },
  colorTemperature: { min: -10, max: 10, step: 1 },
} as const;

export type NumericAdjustment = keyof typeof ADJUSTMENT_RANGES;

export function adjustmentsForMode(mode: Exclude<PictureMode, 'auto'>, custom: PictureAdjustments): PictureAdjustments {
  if (mode === 'custom') return { ...custom };
  return { ...PICTURE_PRESETS[mode] };
}

export function clampAdjustment(key: NumericAdjustment, value: number): number {
  const r = ADJUSTMENT_RANGES[key];
  return Math.min(r.max, Math.max(r.min, Math.round(value)));
}
