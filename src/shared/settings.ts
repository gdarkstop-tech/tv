import { z } from 'zod';

// Persisted user settings. Every field has a default so that an older or
// partially-corrupted settings document always parses into a complete object.

export const pictureAdjustmentsSchema = z.object({
  brightness: z.number().int().min(-30).max(30).default(0),
  contrast: z.number().int().min(-30).max(30).default(0),
  saturation: z.number().int().min(-50).max(50).default(0),
  gamma: z.number().int().min(-30).max(30).default(0),
  hue: z.number().int().min(-30).max(30).default(0),
  sharpness: z.number().int().min(0).max(10).default(0),
  noiseReduction: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  deband: z.boolean().default(true),
  colorTemperature: z.number().int().min(-10).max(10).default(0),
  sdrGamma: z.enum(['auto', '2.2', '2.4', 'srgb']).default('auto'),
  toneMapping: z.enum(['auto', 'bt.2390', 'spline', 'bt.2446a', 'st2094-40', 'mobius', 'hable', 'clip']).default('auto'),
  hdrPeakDetection: z.boolean().default(true),
  motionSmoothing: z.boolean().default(false),
  outputLevels: z.enum(['auto', 'limited', 'full']).default('auto'),
});

const webAppSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(60),
  url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed'),
  openWith: z.enum(['nova', 'browser']).default('nova'),
});

const desktopAppSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(60),
  path: z.string().min(1).max(1024),
});

/** Default name of this television, shown on the home screen, the remote and mirroring receivers. */
export const DEFAULT_TV_NAME = "ALIA'S FAMILY";

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  tvName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^<>"\\\u0000-\u001f]+$/, 'Name contains unsupported characters')
    .default(DEFAULT_TV_NAME),
  display: z
    .object({
      /** Stable display key (EDID based). null = automatic selection. */
      targetDisplayKey: z.string().max(200).nullable().default(null),
      windowMode: z.enum(['fullscreen', 'windowed']).default('fullscreen'),
      preferExternal: z.boolean().default(true),
      reduceMotion: z.boolean().default(false),
      showPerformanceBadge: z.boolean().default(true),
    })
    .default({ targetDisplayKey: null, windowMode: 'fullscreen', preferExternal: true, reduceMotion: false, showPerformanceBadge: true }),
  picture: z
    .object({
      mode: z.enum(['cinema', 'standard', 'vivid', 'gaming', 'custom', 'auto']).default('auto'),
      priority: z.enum(['quality', 'balanced', 'smoothness']).default('balanced'),
      custom: pictureAdjustmentsSchema.default(pictureAdjustmentsSchema.parse({})),
      adaptive: z.boolean().default(true),
    })
    .default({ mode: 'auto', priority: 'balanced', custom: pictureAdjustmentsSchema.parse({}), adaptive: true }),
  playback: z
    .object({
      hardwareDecoding: z.enum(['auto', 'off']).default('auto'),
      resume: z.boolean().default(true),
      autoplayNext: z.boolean().default(true),
      preferredAudioLanguage: z.string().max(20).default(''),
      preferredSubtitleLanguage: z.string().max(20).default(''),
      subtitleScale: z.number().min(0.5).max(2.5).default(1),
      seekStepSeconds: z.number().int().min(5).max(60).default(10),
    })
    .default({ hardwareDecoding: 'auto', resume: true, autoplayNext: true, preferredAudioLanguage: '', preferredSubtitleLanguage: '', subtitleScale: 1, seekStepSeconds: 10 }),
  audio: z
    .object({
      device: z.string().max(300).default('auto'),
      volume: z.number().int().min(0).max(130).default(100),
      passthrough: z.boolean().default(false),
      remoteControlsSystemVolume: z.boolean().default(false),
    })
    .default({ device: 'auto', volume: 100, passthrough: false, remoteControlsSystemVolume: false }),
  remote: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(1024).max(65535).default(8730),
    })
    .default({ enabled: true, port: 8730 }),
  weather: z
    .object({
      location: z
        .object({
          name: z.string().max(120),
          country: z.string().max(120).nullable(),
          admin1: z.string().max(120).nullable(),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        })
        .nullable()
        .default(null),
      units: z.enum(['metric', 'imperial']).default('metric'),
      enabled: z.boolean().default(true),
    })
    .default({ location: null, units: 'metric', enabled: true }),
  startup: z
    .object({
      launchAtLogin: z.boolean().default(false),
      openOnTv: z.boolean().default(true),
    })
    .default({ launchAtLogin: false, openOnTv: true }),
  language: z.enum(['en', 'ar']).default('en'),
  clock24h: z.boolean().default(false),
  apps: z
    .object({
      webApps: z.array(webAppSchema).max(40).default([]),
      desktopApps: z.array(desktopAppSchema).max(40).default([]),
    })
    .default({ webApps: [], desktopApps: [] }),
  tools: z
    .object({
      mpvPath: z.string().max(1024).nullable().default(null),
      ffprobePath: z.string().max(1024).nullable().default(null),
      scrcpyPath: z.string().max(1024).nullable().default(null),
      uxplayPath: z.string().max(1024).nullable().default(null),
    })
    .default({ mpvPath: null, ffprobePath: null, scrcpyPath: null, uxplayPath: null }),
  ir: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().max(200).default(''),
      token: z.string().max(200).default(''),
      actions: z
        .array(
          z.object({
            id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
            label: z.string().min(1).max(60),
            protocol: z.string().min(1).max(30),
            code: z.string().regex(/^(0x)?[0-9a-fA-F]{1,16}$/),
            bits: z.number().int().min(1).max(64),
          }),
        )
        .max(50)
        .default([]),
    })
    .default({ enabled: false, host: '', token: '', actions: [] }),
  onboardingComplete: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;
export type PictureAdjustmentsInput = z.infer<typeof pictureAdjustmentsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge a partial patch into settings. Arrays and scalars replace. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
    const out: Plain = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = merge(a[k], v);
    }
    return out;
  };
  return settingsSchema.parse(merge(base, patch));
}

/** Parse untrusted stored settings, falling back field-by-field to defaults. */
export function parseStoredSettings(raw: unknown): { settings: Settings; repaired: boolean } {
  const full = settingsSchema.safeParse(raw);
  if (full.success) return { settings: full.data, repaired: false };
  // Salvage valid top-level sections, drop the broken ones.
  const defaults = defaultSettings();
  if (!isPlainObject(raw)) return { settings: defaults, repaired: true };
  let current: Settings = defaults;
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in defaults)) continue;
    const attempt = settingsSchema.safeParse({ ...current, [key]: value });
    if (attempt.success) current = attempt.data;
  }
  return { settings: current, repaired: true };
}
