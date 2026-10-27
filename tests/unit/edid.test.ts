import { describe, expect, it } from 'vitest';
import { edidKey, hexToBytes, parseEdid, supportedEotfs } from '../../src/main/hardware/edid';
import { buildEdid, cta, DTD_1080P60, DTD_2160P60, DTD_720P60 } from '../helpers/edid-builder';

describe('EDID parser', () => {
  it('rejects missing or malformed data', () => {
    expect(parseEdid(null).valid).toBe(false);
    expect(parseEdid(new Uint8Array(64)).valid).toBe(false);
    expect(parseEdid(new Uint8Array(128)).valid).toBe(false);
  });

  it('parses a 1080p HDMI television without HDR', () => {
    const edid = buildEdid({
      manufacturer: 'SAM',
      productCode: 0x0f99,
      serial: 0x01000e00,
      year: 2014,
      name: 'SAMSUNG',
      widthCm: 102,
      heightCm: 57,
      preferred: DTD_1080P60,
      cea: [cta.video([16, 31, 4, 19, 32, 33, 34, 5, 20]), cta.audio([1, 2]), cta.hdmiVsdb(225)],
      ceaFlags: 0xf0,
      ceaDtds: [DTD_720P60],
    });
    const info = parseEdid(edid);
    expect(info.valid).toBe(true);
    expect(info.checksumOk).toBe(true);
    expect(info.manufacturerId).toBe('SAM');
    expect(info.productCode).toBe(0x0f99);
    expect(info.monitorName).toBe('SAMSUNG');
    expect(info.manufactureYear).toBe(2014);
    expect(info.physicalSizeCm).toEqual({ width: 102, height: 57 });
    expect(info.nativeMode).toMatchObject({ width: 1920, height: 1080, refreshHz: 60 });
    expect(info.cea?.hdmiVsdb).toBe(true);
    expect(info.cea?.hdmiMaxTmdsMHz).toBe(225);
    expect(info.cea?.audioFormats).toEqual(['LPCM', 'AC-3']);
    expect(info.cea?.underscanITByDefault).toBe(true);
    expect(info.cea?.hdr).toBeNull();
    expect(supportedEotfs(info)).toEqual([]);
    const has = (w: number, h: number, hz: number) => info.modes.some((m) => m.width === w && m.height === h && Math.round(m.refreshHz) === hz);
    expect(has(1920, 1080, 24)).toBe(true);
    expect(has(1920, 1080, 50)).toBe(true);
    expect(has(1280, 720, 60)).toBe(true);
    expect(has(3840, 2160, 60)).toBe(false);
    // Interlaced 1080i is listed but never chosen as native.
    expect(info.modes.some((m) => m.interlaced && m.height === 1080)).toBe(true);
    expect(info.rangeLimits).toMatchObject({ minVHz: 23, maxVHz: 76, maxPixelClockMHz: 600 });
  });

  it('prefers a larger native-flagged VIC over a smaller preferred timing', () => {
    const info = parseEdid(
      buildEdid({
        manufacturer: 'PHL',
        productCode: 7,
        serial: 8,
        year: 2012,
        name: 'PHILIPS',
        widthCm: 80,
        heightCm: 45,
        preferred: DTD_720P60,
        cea: [cta.video([4, 16 | 0x80, 31])],
      }),
    );
    expect(info.nativeMode).toMatchObject({ width: 1920, height: 1080, refreshHz: 60, native: true });
  });

  it('reports a 4K HDR television with 1080p preferred timing honestly', () => {
    const edid = buildEdid({
      manufacturer: 'GSM',
      productCode: 0xc0a1,
      serial: 1,
      year: 2021,
      name: 'LG TV SSCR2',
      serialText: 'ABC123',
      widthCm: 160,
      heightCm: 90,
      preferred: DTD_1080P60,
      cea: [
        cta.video([16, 31, 97, 96, 95, 94, 93]),
        cta.audio([1, 2, 10, 12]),
        cta.hdmiVsdb(300),
        cta.hdmiForum(600),
        cta.colorimetry(true, true),
        cta.hdrStatic(0x0d, 92, 80, 60),
      ],
    });
    const info = parseEdid(edid);
    // VICs above 64 cannot carry the CTA native flag, so the preferred timing stays native…
    expect(info.nativeMode).toMatchObject({ width: 1920, height: 1080, refreshHz: 60 });
    // …while the highest advertised mode is reported separately.
    expect(info.maxMode).toMatchObject({ width: 3840, height: 2160, refreshHz: 60 });
    expect(info.cea?.vics).toContain(97);
    expect(info.cea?.hdmiForumVsdb).toBe(true);
    expect(info.cea?.hdmiMaxTmdsMHz).toBe(600);
    expect(info.cea?.colorimetry).toEqual({ bt2020rgb: true, bt2020ycc: true, dciP3: true });
    expect(info.cea?.hdr?.eotfPq).toBe(true);
    expect(info.cea?.hdr?.eotfHlg).toBe(true);
    expect(info.cea?.hdr?.eotfSdr).toBe(true);
    expect(info.cea?.hdr?.maxLuminance).toBe(Math.round(50 * 2 ** (92 / 32)));
    expect(supportedEotfs(info)).toEqual(['SDR', 'HDR10 (PQ)', 'HLG']);
    expect(info.cea?.audioFormats).toContain('E-AC-3');
    expect(edidKey(info)).toBe('GSM-c0a1-ABC123');
  });

  it('uses a 4K preferred DTD as native', () => {
    const info = parseEdid(
      buildEdid({ manufacturer: 'SNY', productCode: 2, serial: 3, year: 2019, name: 'SONY TV', widthCm: 121, heightCm: 68, preferred: DTD_2160P60 }),
    );
    expect(info.nativeMode).toMatchObject({ width: 3840, height: 2160 });
    expect(info.nativeMode?.refreshHz).toBeCloseTo(60, 1);
  });

  it('parses HDMI 1.4 extended 4K30 resolutions from the VSDB', () => {
    const info = parseEdid(
      buildEdid({
        manufacturer: 'VSC',
        productCode: 5,
        serial: 6,
        year: 2015,
        name: 'VIZIO',
        widthCm: 100,
        heightCm: 56,
        preferred: DTD_1080P60,
        cea: [cta.video([16]), cta.hdmiVsdb(300, 0x78, [1, 3])],
      }),
    );
    expect(info.modes.some((m) => m.width === 3840 && m.height === 2160 && m.refreshHz === 30)).toBe(true);
    expect(info.modes.some((m) => m.width === 3840 && m.height === 2160 && m.refreshHz === 24)).toBe(true);
  });

  it('flags a corrupted checksum without discarding data', () => {
    const edid = buildEdid({ manufacturer: 'ACR', productCode: 1, serial: 1, year: 2010, name: 'X', widthCm: 50, heightCm: 30, preferred: DTD_1080P60 });
    edid[100] = edid[100]! ^ 0xff;
    const info = parseEdid(edid);
    expect(info.valid).toBe(true);
    expect(info.checksumOk).toBe(false);
  });

  it('decodes hex dumps', () => {
    const edid = buildEdid({ manufacturer: 'DEL', productCode: 1, serial: 1, year: 2010, name: 'DELL', widthCm: 50, heightCm: 30, preferred: DTD_1080P60 });
    const hex = Buffer.from(edid).toString('hex').replace(/(..)/g, '$1 ');
    expect(parseEdid(hexToBytes(hex)).monitorName).toBe('DELL');
  });
});
