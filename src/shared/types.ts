// Domain types shared by the main process, the TV renderer and the remote.
// Keep this file free of runtime dependencies so every bundle can import it.

export type Platform = 'win32' | 'linux' | 'darwin' | 'other';

/** How trustworthy a reported capability is. */
export type Verification =
  /** Measured or exercised by NOVA on this machine (e.g. a decode test succeeded). */
  | 'verified'
  /** Reported by the OS/driver/EDID but not exercised by NOVA. */
  | 'reported'
  /** Could not be determined on this machine. */
  | 'unknown'
  /** Determined to be unavailable. */
  | 'unavailable';

export interface Capability<T = boolean> {
  value: T;
  verification: Verification;
  source: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// EDID / displays
// ---------------------------------------------------------------------------

export interface EdidMode {
  width: number;
  height: number;
  refreshHz: number;
  interlaced?: boolean;
  /** Where the mode came from inside the EDID. */
  origin: 'dtd' | 'established' | 'standard' | 'cea-vic';
  native?: boolean;
}

export interface EdidInfo {
  valid: boolean;
  checksumOk: boolean;
  manufacturerId: string;
  productCode: number;
  serialNumber: number;
  manufactureYear: number | null;
  edidVersion: string;
  monitorName: string | null;
  serialText: string | null;
  digitalInput: boolean;
  /** Physical image size reported in the base block, in centimetres. */
  physicalSizeCm: { width: number; height: number } | null;
  nativeMode: EdidMode | null;
  modes: EdidMode[];
  rangeLimits: { minVHz: number; maxVHz: number; minHKHz: number; maxHKHz: number; maxPixelClockMHz: number } | null;
  extensionCount: number;
  cea: {
    present: boolean;
    underscanITByDefault: boolean;
    basicAudio: boolean;
    ycbcr444: boolean;
    ycbcr422: boolean;
    hdmiVsdb: boolean;
    hdmiForumVsdb: boolean;
    hdmiMaxTmdsMHz: number | null;
    deepColor: { dc30: boolean; dc36: boolean; dc48: boolean; y444: boolean } | null;
    colorimetry: { bt2020rgb: boolean; bt2020ycc: boolean; dciP3: boolean } | null;
    hdr: {
      eotfSdr: boolean;
      eotfHdrTraditional: boolean;
      eotfPq: boolean;
      eotfHlg: boolean;
      maxLuminance: number | null;
      maxFrameAvgLuminance: number | null;
      minLuminance: number | null;
    } | null;
    audioFormats: string[];
    vics: number[];
  } | null;
}

export type ConnectionType = 'hdmi' | 'displayport' | 'dvi' | 'vga' | 'internal' | 'usb-c' | 'wireless' | 'virtual' | 'unknown';

export interface DisplayMode {
  width: number;
  height: number;
  refreshHz: number;
  bitsPerPixel?: number;
}

export interface DisplayInfo {
  /** Electron display id. */
  id: number;
  /** Stable key derived from EDID (manufacturer+product+serial) or label+size. */
  key: string;
  label: string;
  internal: boolean;
  primary: boolean;
  /** Bounds in device-independent pixels (what Electron windows use). */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** Current mode in physical pixels. */
  currentMode: DisplayMode;
  rotation: number;
  colorDepth: number;
  colorSpace: string;
  connection: Capability<ConnectionType>;
  nativeResolution: Capability<{ width: number; height: number } | null>;
  /** Modes the OS/driver says are available. */
  availableModes: DisplayMode[];
  hdr: {
    displaySupportsHdr: Capability<boolean>;
    osHdrEnabled: Capability<boolean>;
    supportedEotfs: string[];
  };
  ddcci: Capability<boolean>;
  edid: EdidInfo | null;
  /** Human-readable remarks such as "running below native resolution". */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Hardware report
// ---------------------------------------------------------------------------

export interface GpuInfo {
  vendor: string;
  name: string;
  driverVersion: string | null;
  memoryMB: number | null;
  active: boolean;
  source: string;
}

export interface ToolInfo {
  name: string;
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface DecodeTestResult {
  codec: string;
  label: string;
  sample: string;
  hardware: boolean;
  method: string | null;
  verification: Verification;
  note?: string;
}

export interface HardwareReport {
  schema: 1;
  generatedAt: string;
  appVersion: string;
  environment: {
    platform: Platform;
    osRelease: string;
    osDescription: string;
    arch: string;
    electron: string;
    chrome: string;
    node: string;
    isVirtualMachine: Capability<boolean>;
  };
  cpu: { model: string; logicalCores: number; physicalCores: number | null; speedMHz: number };
  memory: { totalMB: number; freeMB: number };
  gpus: GpuInfo[];
  chromiumGpu: { featureStatus: Record<string, string>; videoDecodeAcceleration: string };
  displays: DisplayInfo[];
  externalDisplayDetected: boolean;
  decoding: {
    hwdecMethodsCompiledIntoMpv: string[];
    tests: DecodeTestResult[];
  };
  audioDevices: Array<{ name: string; description: string }>;
  tools: ToolInfo[];
  network: Array<{ interface: string; address: string; private: boolean }>;
  limitations: string[];
  probeLog: string[];
}

// ---------------------------------------------------------------------------
// Picture / NOVA Vision Engine
// ---------------------------------------------------------------------------

export type PictureMode = 'cinema' | 'standard' | 'vivid' | 'gaming' | 'custom' | 'auto';
export type ProcessingPriority = 'quality' | 'balanced' | 'smoothness';
export type NoiseReduction = 'off' | 'low' | 'medium' | 'high';
export type SdrGamma = 'auto' | '2.2' | '2.4' | 'srgb';
export type ToneMapping = 'auto' | 'bt.2390' | 'spline' | 'bt.2446a' | 'st2094-40' | 'mobius' | 'hable' | 'clip';
export type OutputLevels = 'auto' | 'limited' | 'full';

export interface PictureAdjustments {
  /** -30..30, maps to mpv brightness. */
  brightness: number;
  /** -30..30, maps to mpv contrast. */
  contrast: number;
  /** -50..50, maps to mpv saturation. */
  saturation: number;
  /** -30..30, maps to mpv gamma. */
  gamma: number;
  /** -30..30, maps to mpv hue. */
  hue: number;
  /** 0..10, NOVA contrast-adaptive sharpening shader strength. */
  sharpness: number;
  noiseReduction: NoiseReduction;
  deband: boolean;
  /** -10 (warm) .. 0 (D65 neutral) .. +10 (cool). */
  colorTemperature: number;
  sdrGamma: SdrGamma;
  toneMapping: ToneMapping;
  hdrPeakDetection: boolean;
  motionSmoothing: boolean;
  outputLevels: OutputLevels;
}

export interface PictureSettings {
  mode: PictureMode;
  priority: ProcessingPriority;
  custom: PictureAdjustments;
  /** Allow the Performance Manager to reduce processing when frames drop. */
  adaptive: boolean;
}

export interface VisionStatus {
  requestedMode: PictureMode;
  effectiveMode: Exclude<PictureMode, 'auto'>;
  requestedPriority: ProcessingPriority;
  effectivePriority: ProcessingPriority;
  autoReason: string | null;
  adjustments: PictureAdjustments;
  degradeLevel: number;
  degradeReason: string | null;
  scaler: string;
  shadersActive: string[];
  shaderSupport: Capability<boolean>;
  unsupportedProperties: string[];
  output: {
    displayWidth: number;
    displayHeight: number;
    refreshHz: number;
    hdrPassthrough: boolean;
  } | null;
  source: {
    width: number;
    height: number;
    fps: number;
    hdr: boolean;
    transfer: string | null;
    primaries: string | null;
  } | null;
  /** Honest description of the scaling NOVA performs, e.g. "1280x720 → 1920x1080 (spline36)". */
  scalingDescription: string | null;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
export type MediaKind = 'video' | 'audio' | 'photo';

export interface PlayerTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title: string | null;
  lang: string | null;
  codec: string | null;
  default: boolean;
  forced: boolean;
  external: boolean;
  selected: boolean;
  channels?: number | null;
}

export interface PlayerState {
  status: PlayerStatus;
  engine: {
    available: boolean;
    path: string | null;
    version: string | null;
    mode: 'embedded' | 'standalone' | 'none';
    restarts: number;
  };
  media: {
    id: string | null;
    title: string;
    kind: MediaKind;
    path: string;
  } | null;
  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  tracks: PlayerTrack[];
  video: {
    width: number;
    height: number;
    fps: number;
    codec: string | null;
    hwdec: string | null;
    pixelFormat: string | null;
    hdr: boolean;
    primaries: string | null;
    transfer: string | null;
  } | null;
  audioDevice: string | null;
  error: string | null;
  bufferingSeconds: number | null;
  queue: { index: number; length: number };
}

export type PlayerCommand =
  | { type: 'toggle' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; mode: 'relative' | 'absolute' | 'percent'; value: number }
  | { type: 'volume'; action: 'set' | 'up' | 'down'; value?: number }
  | { type: 'mute'; value?: boolean }
  | { type: 'track'; kind: 'audio' | 'sub'; id: number | 'off' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'subScale'; value: number }
  | { type: 'audioDevice'; name: string };

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export interface LibraryRoot {
  id: number;
  path: string;
  kind: MediaKind;
  addedAt: number;
  available: boolean;
}

export interface MediaItem {
  id: string;
  rootId: number;
  kind: MediaKind;
  title: string;
  fileName: string;
  size: number;
  mtime: number;
  addedAt: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
  hdr: string | null;
  artist: string | null;
  album: string | null;
  hasThumbnail: boolean;
  probed: boolean;
  history: WatchHistory | null;
}

export interface WatchHistory {
  position: number;
  duration: number;
  watched: boolean;
  lastPlayedAt: number;
  playCount: number;
}

export interface LibraryQuery {
  kind: MediaKind;
  filter?: 'all' | 'unwatched' | 'recent';
  sort?: 'title' | 'added' | 'played';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ScanStatus {
  running: boolean;
  scanned: number;
  added: number;
  removed: number;
  probing: number;
  lastScanAt: number | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface PerformanceSample {
  at: number;
  systemCpuPercent: number;
  systemMemoryUsedMB: number;
  systemMemoryTotalMB: number;
  appMemoryMB: number;
  appCpuPercent: number;
  playerCpuPercent: number | null;
  playerMemoryMB: number | null;
  gpu: { utilizationPercent: number | null; memoryUsedMB: number | null; source: string } | null;
  playback: {
    droppedFrames: number;
    decoderDroppedFrames: number;
    delayedFrames: number;
    estimatedFps: number | null;
    containerFps: number | null;
    displayFps: number | null;
    dropsPerSecond: number;
    hwdec: string | null;
    avsync: number | null;
  } | null;
  degradeLevel: number;
}

// ---------------------------------------------------------------------------
// Remote / devices
// ---------------------------------------------------------------------------

export interface PairingInfo {
  open: boolean;
  code: string | null;
  expiresAt: number | null;
  urls: string[];
  qrDataUrl: string | null;
}

export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  connected: boolean;
}

export interface RemoteStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  urls: string[];
  error: string | null;
  pairing: PairingInfo;
  devices: PairedDevice[];
  connectedCount: number;
  secretStorage: 'os-keychain' | 'plaintext-fallback';
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export interface WeatherLocation {
  name: string;
  country: string | null;
  admin1: string | null;
  latitude: number;
  longitude: number;
}

export interface WeatherState {
  location: WeatherLocation | null;
  status: 'unconfigured' | 'ok' | 'stale' | 'error' | 'loading';
  temperature: number | null;
  apparentTemperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  weatherCode: number | null;
  isDay: boolean;
  high: number | null;
  low: number | null;
  units: 'metric' | 'imperial';
  updatedAt: number | null;
  error: string | null;
  attribution: string;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export type IntegrationState = 'available' | 'not-installed' | 'unsupported' | 'running' | 'error';

export interface MirroringOption {
  id: 'laptop-screen' | 'android-scrcpy' | 'iphone-uxplay' | 'windows-miracast';
  state: IntegrationState;
  detail: string;
  canStart: boolean;
  running: boolean;
  installHint: string | null;
}

export interface AppEntry {
  id: string;
  name: string;
  kind: 'web' | 'browser' | 'desktop';
  url?: string;
  available: boolean;
  note?: string;
  builtin: boolean;
}

export interface HardwareControlStatus {
  ddcci: Capability<boolean> & { brightness: number | null; contrast: number | null };
  cec: Capability<boolean> & { adapter: string | null };
  ir: Capability<boolean> & { host: string | null; actions: string[] };
  systemVolume: Capability<boolean> & { level: number | null; muted: boolean | null };
}

// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------

export type NavKey = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'home' | 'menu' | 'info';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}
