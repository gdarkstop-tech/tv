// Builds synthetic but spec-conformant EDIDs for tests.

export interface DtdSpec {
  pixelClockKHz: number;
  hActive: number;
  hBlank: number;
  vActive: number;
  vBlank: number;
  interlaced?: boolean;
}

export const DTD_1080P60: DtdSpec = { pixelClockKHz: 148500, hActive: 1920, hBlank: 280, vActive: 1080, vBlank: 45 };
export const DTD_2160P60: DtdSpec = { pixelClockKHz: 594000, hActive: 3840, hBlank: 560, vActive: 2160, vBlank: 90 };
export const DTD_720P60: DtdSpec = { pixelClockKHz: 74250, hActive: 1280, hBlank: 370, vActive: 720, vBlank: 30 };

function dtd(spec: DtdSpec): number[] {
  const pc = Math.round(spec.pixelClockKHz / 10);
  const d = new Array<number>(18).fill(0);
  d[0] = pc & 0xff;
  d[1] = (pc >> 8) & 0xff;
  d[2] = spec.hActive & 0xff;
  d[3] = spec.hBlank & 0xff;
  d[4] = ((spec.hActive >> 8) << 4) | (spec.hBlank >> 8);
  d[5] = spec.vActive & 0xff;
  d[6] = spec.vBlank & 0xff;
  d[7] = ((spec.vActive >> 8) << 4) | (spec.vBlank >> 8);
  d[17] = spec.interlaced ? 0x80 : 0x18;
  return d;
}

function textDescriptor(tag: number, text: string): number[] {
  const d = [0, 0, 0, tag, 0];
  const bytes = [...text.slice(0, 13)].map((c) => c.charCodeAt(0));
  if (bytes.length < 13) bytes.push(0x0a);
  while (bytes.length < 13) bytes.push(0x20);
  return [...d, ...bytes];
}

function rangeDescriptor(minV: number, maxV: number, minH: number, maxH: number, maxClockMHz: number): number[] {
  return [0, 0, 0, 0xfd, 0, minV, maxV, minH, maxH, Math.round(maxClockMHz / 10), 0, 0x0a, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];
}

function fixChecksum(block: number[]): number[] {
  const sum = block.slice(0, 127).reduce((a, b) => a + b, 0);
  block[127] = (256 - (sum % 256)) % 256;
  return block;
}

export interface EdidSpec {
  manufacturer: string;
  productCode: number;
  serial: number;
  year: number;
  name: string;
  serialText?: string;
  widthCm: number;
  heightCm: number;
  preferred: DtdSpec;
  establishedBytes?: [number, number, number];
  standardTimings?: Array<[number, number]>;
  cea?: number[][]; // data blocks (each including its header byte)
  ceaFlags?: number;
  ceaDtds?: DtdSpec[];
}

export function buildEdid(spec: EdidSpec): Uint8Array {
  const b = new Array<number>(128).fill(0);
  [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00].forEach((v, i) => (b[i] = v));
  const m = spec.manufacturer.toUpperCase();
  const id = ((m.charCodeAt(0) - 64) << 10) | ((m.charCodeAt(1) - 64) << 5) | (m.charCodeAt(2) - 64);
  b[8] = (id >> 8) & 0xff;
  b[9] = id & 0xff;
  b[10] = spec.productCode & 0xff;
  b[11] = (spec.productCode >> 8) & 0xff;
  b[12] = spec.serial & 0xff;
  b[13] = (spec.serial >> 8) & 0xff;
  b[14] = (spec.serial >> 16) & 0xff;
  b[15] = (spec.serial >> 24) & 0xff;
  b[16] = 1;
  b[17] = spec.year - 1990;
  b[18] = 1;
  b[19] = 3;
  b[20] = 0x80;
  b[21] = spec.widthCm;
  b[22] = spec.heightCm;
  b[23] = 120;
  b[24] = 0x0a;
  const est = spec.establishedBytes ?? [0x21, 0x08, 0x00];
  b[35] = est[0];
  b[36] = est[1];
  b[37] = est[2];
  for (let i = 0; i < 8; i++) {
    const st = spec.standardTimings?.[i];
    b[38 + i * 2] = st ? st[0] : 0x01;
    b[39 + i * 2] = st ? st[1] : 0x01;
  }
  const descriptors = [
    dtd(spec.preferred),
    rangeDescriptor(23, 76, 15, 136, 600),
    textDescriptor(0xfc, spec.name),
    spec.serialText ? textDescriptor(0xff, spec.serialText) : textDescriptor(0x10, ''),
  ];
  descriptors.forEach((d, i) => d.forEach((v, j) => (b[54 + i * 18 + j] = v)));
  b[126] = spec.cea ? 1 : 0;
  fixChecksum(b);
  if (!spec.cea) return new Uint8Array(b);

  const c = new Array<number>(128).fill(0);
  c[0] = 0x02;
  c[1] = 0x03;
  const data = spec.cea.flat();
  const dtdOffset = 4 + data.length;
  c[2] = dtdOffset;
  c[3] = spec.ceaFlags ?? 0xf0;
  data.forEach((v, i) => (c[4 + i] = v));
  let off = dtdOffset;
  for (const d of spec.ceaDtds ?? []) {
    dtd(d).forEach((v, j) => (c[off + j] = v));
    off += 18;
  }
  fixChecksum(c);
  return new Uint8Array([...b, ...c]);
}

/** CTA data block helpers. */
export const cta = {
  video: (svds: number[]) => [(2 << 5) | svds.length, ...svds],
  audio: (formats: number[]) => [(1 << 5) | (formats.length * 3), ...formats.flatMap((f) => [(f << 3) | 1, 0x07, 0x07])],
  hdmiVsdb: (maxTmdsMHz: number, deepColorFlags = 0x78, hdmiVics: number[] = []) => {
    const payload = [0x03, 0x0c, 0x00, 0x10, 0x00, deepColorFlags, Math.round(maxTmdsMHz / 5)];
    if (hdmiVics.length) payload.push(0x20, 0x00, hdmiVics.length << 5, ...hdmiVics);
    return [(3 << 5) | payload.length, ...payload];
  },
  hdmiForum: (maxTmdsMHz: number) => {
    const payload = [0xd8, 0x5d, 0xc4, 0x01, Math.round(maxTmdsMHz / 5), 0x80, 0x00];
    return [(3 << 5) | payload.length, ...payload];
  },
  colorimetry: (bt2020: boolean, dciP3: boolean) => [(7 << 5) | 3, 5, bt2020 ? 0xc0 : 0x00, dciP3 ? 0x80 : 0x00],
  hdrStatic: (eotfBits: number, maxCv: number, avgCv: number, minCv: number) => [(7 << 5) | 6, 6, eotfBits, 0x01, maxCv, avgCv, minCv],
};
