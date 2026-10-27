import type { EdidInfo, EdidMode } from '../../shared/types';

// EDID 1.3/1.4 + CTA-861 extension parser. Pure function over bytes so it can
// be tested without hardware. Everything returned here is "reported" data:
// it is what the television claims, not something NOVA measured.

const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

/** CTA-861 VIC → mode. Covers the formats televisions commonly advertise. */
const VIC_TABLE: Record<number, [number, number, number, boolean?]> = {
  1: [640, 480, 60],
  2: [720, 480, 60],
  3: [720, 480, 60],
  4: [1280, 720, 60],
  5: [1920, 1080, 60, true],
  6: [1440, 480, 60, true],
  7: [1440, 480, 60, true],
  16: [1920, 1080, 60],
  17: [720, 576, 50],
  18: [720, 576, 50],
  19: [1280, 720, 50],
  20: [1920, 1080, 50, true],
  21: [1440, 576, 50, true],
  22: [1440, 576, 50, true],
  31: [1920, 1080, 50],
  32: [1920, 1080, 24],
  33: [1920, 1080, 25],
  34: [1920, 1080, 30],
  39: [1920, 1080, 50, true],
  40: [1920, 1080, 100, true],
  41: [1280, 720, 100],
  46: [1920, 1080, 120, true],
  47: [1280, 720, 120],
  60: [1280, 720, 24],
  61: [1280, 720, 25],
  62: [1280, 720, 30],
  63: [1920, 1080, 120],
  64: [1920, 1080, 100],
  93: [3840, 2160, 24],
  94: [3840, 2160, 25],
  95: [3840, 2160, 30],
  96: [3840, 2160, 50],
  97: [3840, 2160, 60],
  98: [4096, 2160, 24],
  99: [4096, 2160, 25],
  100: [4096, 2160, 30],
  101: [4096, 2160, 50],
  102: [4096, 2160, 60],
  103: [3840, 2160, 24],
  104: [3840, 2160, 25],
  105: [3840, 2160, 30],
  106: [3840, 2160, 50],
  107: [3840, 2160, 60],
  117: [3840, 2160, 100],
  118: [3840, 2160, 120],
  194: [7680, 4320, 24],
  195: [7680, 4320, 25],
  196: [7680, 4320, 30],
  197: [7680, 4320, 48],
  198: [7680, 4320, 50],
  199: [7680, 4320, 60],
  200: [7680, 4320, 100],
  201: [7680, 4320, 120],
};

/** HDMI 1.4 VSDB "HDMI_VIC" extended resolutions. */
const HDMI_VIC_TABLE: Record<number, [number, number, number]> = {
  1: [3840, 2160, 30],
  2: [3840, 2160, 25],
  3: [3840, 2160, 24],
  4: [4096, 2160, 24],
};

const ESTABLISHED_TIMINGS: Array<{ byte: number; bit: number; w: number; h: number; hz: number; interlaced?: boolean }> = [
  { byte: 35, bit: 7, w: 720, h: 400, hz: 70 },
  { byte: 35, bit: 6, w: 720, h: 400, hz: 88 },
  { byte: 35, bit: 5, w: 640, h: 480, hz: 60 },
  { byte: 35, bit: 4, w: 640, h: 480, hz: 67 },
  { byte: 35, bit: 3, w: 640, h: 480, hz: 72 },
  { byte: 35, bit: 2, w: 640, h: 480, hz: 75 },
  { byte: 35, bit: 1, w: 800, h: 600, hz: 56 },
  { byte: 35, bit: 0, w: 800, h: 600, hz: 60 },
  { byte: 36, bit: 7, w: 800, h: 600, hz: 72 },
  { byte: 36, bit: 6, w: 800, h: 600, hz: 75 },
  { byte: 36, bit: 5, w: 832, h: 624, hz: 75 },
  { byte: 36, bit: 4, w: 1024, h: 768, hz: 87, interlaced: true },
  { byte: 36, bit: 3, w: 1024, h: 768, hz: 60 },
  { byte: 36, bit: 2, w: 1024, h: 768, hz: 70 },
  { byte: 36, bit: 1, w: 1024, h: 768, hz: 75 },
  { byte: 36, bit: 0, w: 1280, h: 1024, hz: 75 },
  { byte: 37, bit: 7, w: 1152, h: 870, hz: 75 },
];

const AUDIO_FORMATS: Record<number, string> = {
  1: 'LPCM',
  2: 'AC-3',
  3: 'MPEG-1',
  4: 'MP3',
  5: 'MPEG-2',
  6: 'AAC',
  7: 'DTS',
  8: 'ATRAC',
  9: 'DSD',
  10: 'E-AC-3',
  11: 'DTS-HD',
  12: 'MAT (Dolby TrueHD/Atmos)',
  13: 'DST',
  14: 'WMA Pro',
};

export function emptyEdid(): EdidInfo {
  return {
    valid: false,
    checksumOk: false,
    manufacturerId: '',
    productCode: 0,
    serialNumber: 0,
    manufactureYear: null,
    edidVersion: '',
    monitorName: null,
    serialText: null,
    digitalInput: false,
    physicalSizeCm: null,
    nativeMode: null,
    maxMode: null,
    modes: [],
    rangeLimits: null,
    extensionCount: 0,
    cea: null,
  };
}

function checksum(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum = (sum + block[i]!) & 0xff;
  return sum === 0;
}

function decodeText(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0x0a || b === 0x00) break;
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
  }
  return s.trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseDtd(d: Uint8Array): EdidMode | null {
  const pixelClock = (d[0]! | (d[1]! << 8)) * 10_000;
  if (pixelClock === 0) return null;
  const hActive = d[2]! | ((d[4]! & 0xf0) << 4);
  const hBlank = d[3]! | ((d[4]! & 0x0f) << 8);
  const vActive = d[5]! | ((d[7]! & 0xf0) << 4);
  const vBlank = d[6]! | ((d[7]! & 0x0f) << 8);
  const interlaced = (d[17]! & 0x80) !== 0;
  const hTotal = hActive + hBlank;
  const vTotal = vActive + vBlank;
  if (hActive === 0 || vActive === 0 || hTotal === 0 || vTotal === 0) return null;
  // For interlaced modes vActive is per field; refresh is the field rate.
  const refresh = pixelClock / (hTotal * vTotal);
  return {
    width: hActive,
    height: interlaced ? vActive * 2 : vActive,
    refreshHz: round2(refresh),
    interlaced,
    origin: 'dtd',
  };
}

function parseStandardTiming(b0: number, b1: number, edidMinor: number): EdidMode | null {
  if ((b0 === 0x01 && b1 === 0x01) || b0 === 0x00) return null;
  const width = (b0 + 31) * 8;
  const aspect = (b1 >> 6) & 0x03;
  let height: number;
  switch (aspect) {
    case 0:
      height = edidMinor >= 3 ? Math.round((width * 10) / 16) : width;
      break;
    case 1:
      height = Math.round((width * 3) / 4);
      break;
    case 2:
      height = Math.round((width * 4) / 5);
      break;
    default:
      height = Math.round((width * 9) / 16);
  }
  return { width, height, refreshHz: (b1 & 0x3f) + 60, origin: 'standard' };
}

function modeKey(m: EdidMode): string {
  return `${m.width}x${m.height}@${Math.round(m.refreshHz)}${m.interlaced ? 'i' : ''}`;
}

export function parseEdid(input: Uint8Array | Buffer | null | undefined): EdidInfo {
  const info = emptyEdid();
  if (!input || input.length < 128) return info;
  const bytes = new Uint8Array(input);
  for (let i = 0; i < 8; i++) if (bytes[i] !== HEADER[i]) return info;

  const base = bytes.subarray(0, 128);
  info.valid = true;
  info.checksumOk = checksum(base);

  const mfg = (base[8]! << 8) | base[9]!;
  info.manufacturerId = String.fromCharCode(
    ((mfg >> 10) & 0x1f) + 64,
    ((mfg >> 5) & 0x1f) + 64,
    (mfg & 0x1f) + 64,
  );
  info.productCode = base[10]! | (base[11]! << 8);
  info.serialNumber = (base[12]! | (base[13]! << 8) | (base[14]! << 16) | (base[15]! << 24)) >>> 0;
  info.manufactureYear = base[17]! > 0 ? base[17]! + 1990 : null;
  const minor = base[19]!;
  info.edidVersion = `${base[18]}.${minor}`;
  info.digitalInput = (base[20]! & 0x80) !== 0;
  if (base[21]! > 0 && base[22]! > 0) info.physicalSizeCm = { width: base[21]!, height: base[22]! };
  info.extensionCount = base[126]!;

  const modes = new Map<string, EdidMode>();
  const addMode = (m: EdidMode | null) => {
    if (!m) return;
    const k = modeKey(m);
    const existing = modes.get(k);
    if (!existing) modes.set(k, m);
    else if (m.native && !existing.native) existing.native = true;
  };

  for (const t of ESTABLISHED_TIMINGS) {
    if (base[t.byte]! & (1 << t.bit)) {
      addMode({ width: t.w, height: t.h, refreshHz: t.hz, interlaced: t.interlaced ?? false, origin: 'established' });
    }
  }
  for (let i = 38; i < 54; i += 2) addMode(parseStandardTiming(base[i]!, base[i + 1]!, minor));

  let preferred: EdidMode | null = null;
  for (let off = 54; off <= 108; off += 18) {
    const d = base.subarray(off, off + 18);
    const dtd = parseDtd(d);
    if (dtd) {
      if (!preferred) preferred = dtd;
      addMode(dtd);
      continue;
    }
    const tag = d[3]!;
    if (tag === 0xfc) info.monitorName = decodeText(d.subarray(5, 18)) || null;
    else if (tag === 0xff) info.serialText = decodeText(d.subarray(5, 18)) || null;
    else if (tag === 0xfd) {
      const flags = d[4]!;
      const vOffMin = flags & 0x01 ? 255 : 0;
      const vOffMax = flags & 0x02 ? 255 : 0;
      const hOffMin = flags & 0x04 ? 255 : 0;
      const hOffMax = flags & 0x08 ? 255 : 0;
      info.rangeLimits = {
        minVHz: d[5]! + vOffMin,
        maxVHz: d[6]! + vOffMax,
        minHKHz: d[7]! + hOffMin,
        maxHKHz: d[8]! + hOffMax,
        maxPixelClockMHz: d[9]! * 10,
      };
    } else if (tag === 0xfa) {
      for (let i = 5; i < 17; i += 2) addMode(parseStandardTiming(d[i]!, d[i + 1]!, minor));
    }
  }

  // Extensions.
  let nativeCandidate: EdidMode | null = null;
  for (let ext = 1; ext <= info.extensionCount; ext++) {
    const start = ext * 128;
    if (bytes.length < start + 128) break;
    const block = bytes.subarray(start, start + 128);
    if (block[0] !== 0x02) continue; // only CTA-861 extensions
    if (!checksum(block)) info.checksumOk = false;
    const cea = parseCea(block, addMode);
    info.cea = mergeCea(info.cea, cea.info);
    if (cea.nativeCandidate && (!nativeCandidate || area(cea.nativeCandidate) > area(nativeCandidate))) {
      nativeCandidate = cea.nativeCandidate;
    }
  }

  if (preferred) preferred.native = true;
  // Some 4K TVs keep 1080p in the base-block preferred timing for legacy
  // sources and flag the real panel format as "native" in the CTA video
  // block. Prefer the larger native-flagged format when present.
  let native: EdidMode | null = preferred;
  if (nativeCandidate && (!native || area(nativeCandidate) > area(native))) native = nativeCandidate;
  if (native) {
    const k = modeKey(native);
    const m = modes.get(k);
    if (m) m.native = true;
    info.nativeMode = { ...native, native: true };
  }

  info.modes = [...modes.values()].sort(
    (a, b) => area(b) - area(a) || b.refreshHz - a.refreshHz || Number(a.interlaced) - Number(b.interlaced),
  );
  const progressive = info.modes.filter((m) => !m.interlaced);
  info.maxMode = progressive[0] ? { ...progressive[0] } : null;
  return info;
}

function area(m: EdidMode): number {
  return m.width * m.height;
}

type CeaInfo = NonNullable<EdidInfo['cea']>;

function mergeCea(a: CeaInfo | null, b: CeaInfo): CeaInfo {
  if (!a) return b;
  return {
    ...a,
    present: true,
    ycbcr444: a.ycbcr444 || b.ycbcr444,
    ycbcr422: a.ycbcr422 || b.ycbcr422,
    basicAudio: a.basicAudio || b.basicAudio,
    hdmiVsdb: a.hdmiVsdb || b.hdmiVsdb,
    hdmiForumVsdb: a.hdmiForumVsdb || b.hdmiForumVsdb,
    hdmiMaxTmdsMHz: Math.max(a.hdmiMaxTmdsMHz ?? 0, b.hdmiMaxTmdsMHz ?? 0) || null,
    deepColor: a.deepColor ?? b.deepColor,
    colorimetry: a.colorimetry ?? b.colorimetry,
    hdr: a.hdr ?? b.hdr,
    audioFormats: [...new Set([...a.audioFormats, ...b.audioFormats])],
    vics: [...new Set([...a.vics, ...b.vics])],
  };
}

function parseCea(block: Uint8Array, addMode: (m: EdidMode | null) => void): { info: CeaInfo; nativeCandidate: EdidMode | null } {
  const info: CeaInfo = {
    present: true,
    underscanITByDefault: (block[3]! & 0x80) !== 0,
    basicAudio: (block[3]! & 0x40) !== 0,
    ycbcr444: (block[3]! & 0x20) !== 0,
    ycbcr422: (block[3]! & 0x10) !== 0,
    hdmiVsdb: false,
    hdmiForumVsdb: false,
    hdmiMaxTmdsMHz: null,
    deepColor: null,
    colorimetry: null,
    hdr: null,
    audioFormats: [],
    vics: [],
  };
  let nativeCandidate: EdidMode | null = null;
  const dtdOffset = block[2]!;
  const end = dtdOffset >= 4 && dtdOffset <= 127 ? dtdOffset : 4;

  let i = 4;
  while (i < end) {
    const header = block[i]!;
    const tag = (header >> 5) & 0x07;
    const len = header & 0x1f;
    const p = block.subarray(i + 1, Math.min(i + 1 + len, end));
    i += 1 + len;
    if (tag === 1) {
      for (let j = 0; j + 2 < p.length; j += 3) {
        const fmt = (p[j]! >> 3) & 0x0f;
        const name = AUDIO_FORMATS[fmt];
        if (name && !info.audioFormats.includes(name)) info.audioFormats.push(name);
      }
    } else if (tag === 2) {
      for (const svd of p) {
        let vic = svd;
        let native = false;
        if (svd >= 129 && svd <= 192) {
          vic = svd & 0x7f;
          native = true;
        }
        info.vics.push(vic);
        const v = VIC_TABLE[vic];
        if (v) {
          const mode: EdidMode = { width: v[0], height: v[1], refreshHz: v[2], interlaced: v[3] ?? false, origin: 'cea-vic', native };
          addMode(mode);
          if (native && !mode.interlaced && (!nativeCandidate || area(mode) > area(nativeCandidate))) nativeCandidate = mode;
        }
      }
    } else if (tag === 3 && p.length >= 3) {
      const oui = p[0]! | (p[1]! << 8) | (p[2]! << 16);
      if (oui === 0x000c03) {
        info.hdmiVsdb = true;
        if (p.length >= 6) {
          const f = p[5]!;
          info.deepColor = {
            dc48: (f & 0x40) !== 0,
            dc36: (f & 0x20) !== 0,
            dc30: (f & 0x10) !== 0,
            y444: (f & 0x08) !== 0,
          };
        }
        if (p.length >= 7 && p[6]! > 0) info.hdmiMaxTmdsMHz = Math.max(info.hdmiMaxTmdsMHz ?? 0, p[6]! * 5);
        if (p.length >= 8) {
          const flags = p[7]!;
          let off = 8;
          if (flags & 0x80) off += 2; // video/audio latency
          if (flags & 0x40) off += 2; // interlaced latency
          if (flags & 0x20 && p.length > off + 1) {
            const hdmiVicLen = (p[off + 1]! >> 5) & 0x07;
            off += 2;
            for (let k = 0; k < hdmiVicLen && off + k < p.length; k++) {
              const hv = HDMI_VIC_TABLE[p[off + k]!];
              if (hv) addMode({ width: hv[0], height: hv[1], refreshHz: hv[2], origin: 'cea-vic' });
            }
          }
        }
      } else if (oui === 0xc45dd8) {
        info.hdmiForumVsdb = true;
        if (p.length >= 5 && p[4]! > 0) info.hdmiMaxTmdsMHz = Math.max(info.hdmiMaxTmdsMHz ?? 0, p[4]! * 5);
      }
    } else if (tag === 7 && p.length >= 1) {
      const ext = p[0]!;
      if (ext === 5 && p.length >= 2) {
        info.colorimetry = {
          bt2020rgb: (p[1]! & 0x80) !== 0,
          bt2020ycc: (p[1]! & 0x40) !== 0,
          dciP3: p.length >= 3 ? (p[2]! & 0x80) !== 0 : false,
        };
      } else if (ext === 6 && p.length >= 2) {
        const eotf = p[1]!;
        const lum = (cv: number | undefined) => (cv && cv > 0 ? Math.round(50 * Math.pow(2, cv / 32)) : null);
        const maxL = lum(p[3]);
        const minCv = p[5];
        info.hdr = {
          eotfSdr: (eotf & 0x01) !== 0,
          eotfHdrTraditional: (eotf & 0x02) !== 0,
          eotfPq: (eotf & 0x04) !== 0,
          eotfHlg: (eotf & 0x08) !== 0,
          maxLuminance: maxL,
          maxFrameAvgLuminance: lum(p[4]),
          minLuminance: maxL !== null && minCv !== undefined ? round2((maxL * Math.pow(minCv / 255, 2)) / 100) : null,
        };
      }
    }
  }

  // Detailed timings in the extension block.
  for (let off = dtdOffset; off >= 4 && off + 18 <= 127; off += 18) {
    const dtd = parseDtd(block.subarray(off, off + 18));
    if (!dtd) break;
    addMode(dtd);
  }
  return { info, nativeCandidate };
}

/** Stable identity for a display across reboots and port changes. */
export function edidKey(info: EdidInfo): string | null {
  if (!info.valid) return null;
  const serial = info.serialText || (info.serialNumber ? String(info.serialNumber) : '0');
  return `${info.manufacturerId}-${info.productCode.toString(16).padStart(4, '0')}-${serial}`;
}

export function supportedEotfs(info: EdidInfo | null): string[] {
  const h = info?.cea?.hdr;
  if (!h) return [];
  const out: string[] = [];
  if (h.eotfSdr) out.push('SDR');
  if (h.eotfPq) out.push('HDR10 (PQ)');
  if (h.eotfHlg) out.push('HLG');
  if (h.eotfHdrTraditional) out.push('Traditional HDR');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
