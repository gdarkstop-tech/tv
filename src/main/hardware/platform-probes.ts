import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionType, DisplayMode } from '../../shared/types';
import { run } from '../util/exec';
import { locateTool } from './tools';
import { windowsHelper, type WinDisplayPath } from './windows-helper';

// Per-OS display probes. Each returns what the operating system reports about
// connected displays, normalised into PlatformDisplay. Nothing here changes
// display configuration.

export interface PlatformDisplay {
  /** Rectangle in physical pixels used to match Electron displays. */
  rect: { x: number; y: number; width: number; height: number } | null;
  name: string | null;
  connector: string | null;
  connection: ConnectionType;
  connectionSource: string;
  edid: Uint8Array | null;
  modes: DisplayMode[];
  current: DisplayMode | null;
  hdr: { supported: boolean; enabled: boolean; bitsPerColor: number | null; source: string } | null;
  gdiName: string | null;
  adapterName: string | null;
  errors: string[];
}

export interface PlatformProbeResult {
  displays: PlatformDisplay[];
  log: string[];
}

export function connectionFromConnector(name: string): ConnectionType {
  const n = name.toUpperCase();
  if (n.startsWith('HDMI')) return 'hdmi';
  if (n.startsWith('EDP') || n.startsWith('LVDS') || n.startsWith('DSI')) return 'internal';
  if (n.startsWith('DP') || n.startsWith('DISPLAYPORT')) return 'displayport';
  if (n.startsWith('DVI')) return 'dvi';
  if (n.startsWith('VGA')) return 'vga';
  if (n.startsWith('VIRTUAL') || n === 'SCREEN') return 'virtual';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export async function probeWindows(): Promise<PlatformProbeResult> {
  const log: string[] = [];
  const paths = await windowsHelper.call<WinDisplayPath[]>('displays', {}, 45000);
  const list = Array.isArray(paths) ? paths : [paths];
  const displays = list.map((p): PlatformDisplay => {
    const modes: DisplayMode[] = (p.Modes ?? [])
      .filter((m) => !m.Interlaced)
      .map((m) => ({ width: m.Width, height: m.Height, refreshHz: m.RefreshHz, bitsPerPixel: m.BitsPerPixel }));
    const conn = (p.OutputTechnology as ConnectionType) ?? 'unknown';
    return {
      rect: p.Width > 0 ? { x: p.X, y: p.Y, width: p.Width, height: p.Height } : null,
      name: p.FriendlyName || null,
      connector: p.GdiName,
      connection: ['hdmi', 'displayport', 'dvi', 'vga', 'internal', 'usb-c', 'wireless', 'virtual'].includes(conn) ? conn : 'unknown',
      connectionSource: 'Windows DisplayConfig (outputTechnology)',
      edid: p.EdidBase64 ? new Uint8Array(Buffer.from(p.EdidBase64, 'base64')) : null,
      modes,
      current: p.Current ? { width: p.Current.Width, height: p.Current.Height, refreshHz: p.RefreshHz || p.Current.RefreshHz, bitsPerPixel: p.Current.BitsPerPixel } : null,
      hdr: p.AdvancedColorQueried
        ? {
            supported: p.AdvancedColorSupported,
            enabled: p.AdvancedColorEnabled,
            bitsPerColor: p.BitsPerColorChannel || null,
            source: 'Windows DisplayConfig advanced colour info',
          }
        : null,
      gdiName: p.GdiName,
      adapterName: p.AdapterName,
      errors: p.Errors ?? [],
    };
  });
  log.push(`Windows DisplayConfig reported ${displays.length} active display path(s)`);
  return { displays, log };
}

// ---------------------------------------------------------------------------
// Linux (DRM sysfs + xrandr)
// ---------------------------------------------------------------------------

interface SysfsConnector {
  connector: string;
  connected: boolean;
  edid: Uint8Array | null;
  modes: string[];
}

export function readSysfsConnectors(root = '/sys/class/drm'): SysfsConnector[] {
  const out: SysfsConnector[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    const m = e.match(/^card\d+-(.+)$/);
    if (!m) continue;
    const dir = path.join(root, e);
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(dir, f));
      } catch {
        return null;
      }
    };
    const status = read('status')?.toString().trim();
    const edid = read('edid');
    out.push({
      connector: m[1]!,
      connected: status === 'connected',
      edid: edid && edid.length >= 128 ? new Uint8Array(edid) : null,
      modes: (read('modes')?.toString() ?? '').split('\n').filter(Boolean),
    });
  }
  return out;
}

export interface XrandrOutput {
  name: string;
  connected: boolean;
  primary: boolean;
  geometry: { width: number; height: number; x: number; y: number } | null;
  modes: Array<DisplayMode & { current: boolean; preferred: boolean }>;
  edid: Uint8Array | null;
}

/** Parses `xrandr --query --props` output. */
export function parseXrandr(text: string): XrandrOutput[] {
  const outputs: XrandrOutput[] = [];
  let cur: XrandrOutput | null = null;
  let inEdid = false;
  let edidHex = '';
  const flushEdid = () => {
    if (cur && edidHex) {
      const bytes = new Uint8Array(edidHex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(edidHex.slice(i * 2, i * 2 + 2), 16);
      cur.edid = bytes;
    }
    edidHex = '';
    inEdid = false;
  };
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^(\S+)\s+(connected|disconnected)(\s+primary)?\s*(\d+)?x?(\d+)?\+?(-?\d+)?\+?(-?\d+)?/);
    if (head) {
      flushEdid();
      cur = {
        name: head[1]!,
        connected: head[2] === 'connected',
        primary: Boolean(head[3]),
        geometry: head[4] ? { width: +head[4], height: +head[5]!, x: +(head[6] ?? 0), y: +(head[7] ?? 0) } : null,
        modes: [],
        edid: null,
      };
      outputs.push(cur);
      continue;
    }
    if (/^Screen \d+:/.test(line)) {
      flushEdid();
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (/^\s+EDID:\s*$/.test(line)) {
      inEdid = true;
      edidHex = '';
      continue;
    }
    if (inEdid) {
      const hex = line.trim();
      if (/^[0-9a-fA-F]+$/.test(hex)) {
        edidHex += hex;
        continue;
      }
      flushEdid();
    }
    const mode = line.match(/^\s{2,}(\d+)x(\d+)i?\s+(.*)$/);
    if (mode && !line.includes(':')) {
      const rates = mode[3]!.trim().split(/\s+/);
      for (const r of rates) {
        const rm = r.match(/^([\d.]+)([*+ ]*)/);
        if (!rm) continue;
        cur.modes.push({
          width: +mode[1]!,
          height: +mode[2]!,
          refreshHz: Math.round(parseFloat(rm[1]!) * 100) / 100,
          current: rm[2]!.includes('*'),
          preferred: rm[2]!.includes('+') || r.endsWith('+'),
        });
      }
    }
  }
  flushEdid();
  return outputs;
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length < 128 || b.length < 128) return false;
  for (let i = 0; i < 128; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function probeLinux(): Promise<PlatformProbeResult> {
  const log: string[] = [];
  const sysfs = readSysfsConnectors();
  log.push(`DRM sysfs: ${sysfs.length} connector(s), ${sysfs.filter((c) => c.connected).length} connected`);
  let xr: XrandrOutput[] = [];
  const xrandr = process.env.DISPLAY ? locateTool('xrandr') : null;
  if (xrandr) {
    const r = await run(xrandr, ['--query', '--props'], { timeoutMs: 8000 });
    if (r.ok) {
      xr = parseXrandr(r.stdout);
      log.push(`xrandr: ${xr.length} output(s), ${xr.filter((o) => o.connected).length} connected`);
    } else log.push(`xrandr failed: ${r.error}`);
  } else log.push('xrandr unavailable (no X11 DISPLAY or binary missing)');

  const displays: PlatformDisplay[] = [];
  const usedSysfs = new Set<string>();
  for (const o of xr.filter((x) => x.connected)) {
    const sys = sysfs.find((s) => s.connected && sameBytes(s.edid, o.edid)) ?? null;
    if (sys) usedSysfs.add(sys.connector);
    const connectorName = sys?.connector ?? o.name;
    const current = o.modes.find((m) => m.current) ?? null;
    displays.push({
      rect: o.geometry,
      name: null,
      connector: connectorName,
      connection: connectionFromConnector(connectorName),
      connectionSource: sys ? 'Linux DRM connector name' : 'xrandr output name',
      edid: o.edid ?? sys?.edid ?? null,
      modes: o.modes.map(({ width, height, refreshHz }) => ({ width, height, refreshHz })),
      current: current ? { width: current.width, height: current.height, refreshHz: current.refreshHz } : null,
      hdr: null,
      gdiName: null,
      adapterName: null,
      errors: [],
    });
  }
  // Connected connectors that X11 does not show (e.g. Wayland sessions).
  for (const s of sysfs.filter((c) => c.connected && !usedSysfs.has(c.connector))) {
    if (xr.length > 0) continue;
    displays.push({
      rect: null,
      name: null,
      connector: s.connector,
      connection: connectionFromConnector(s.connector),
      connectionSource: 'Linux DRM connector name',
      edid: s.edid,
      modes: s.modes
        .map((m) => m.match(/^(\d+)x(\d+)/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => ({ width: +m[1]!, height: +m[2]!, refreshHz: 0 })),
      current: null,
      hdr: null,
      gdiName: null,
      adapterName: null,
      errors: ['refresh rates unavailable without X11 (sysfs lists resolutions only)'],
    });
  }
  return { displays, log };
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

export async function probeMac(): Promise<PlatformProbeResult> {
  const log: string[] = [];
  const r = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 20000 });
  if (!r.ok) return { displays: [], log: [`system_profiler failed: ${r.error}`] };
  const displays: PlatformDisplay[] = [];
  try {
    const json = JSON.parse(r.stdout) as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_ndrvs?: Array<Record<string, string>> }> };
    for (const gpu of json.SPDisplaysDataType ?? []) {
      for (const d of gpu.spdisplays_ndrvs ?? []) {
        const pixels = (d._spdisplays_pixels ?? '').match(/(\d+)\s*x\s*(\d+)/);
        const res = (d._spdisplays_resolution ?? '').match(/(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)\s*Hz)?/);
        const internal = (d.spdisplays_connection_type ?? '').includes('internal');
        displays.push({
          rect: null,
          name: d._name ?? null,
          connector: d.spdisplays_connection_type ?? null,
          connection: internal ? 'internal' : 'unknown',
          connectionSource: 'macOS system_profiler',
          edid: null,
          modes: [],
          current: res ? { width: +res[1]!, height: +res[2]!, refreshHz: res[3] ? parseFloat(res[3]) : 0 } : null,
          hdr: null,
          gdiName: null,
          adapterName: gpu.sppci_model ?? null,
          errors: pixels ? [] : ['native pixel size not reported'],
        });
      }
    }
    log.push(`system_profiler: ${displays.length} display(s)`);
  } catch (err) {
    log.push(`system_profiler output not parseable: ${String(err)}`);
  }
  return { displays, log };
}

export async function probePlatformDisplays(): Promise<PlatformProbeResult> {
  try {
    if (process.platform === 'win32') return await probeWindows();
    if (process.platform === 'linux') return await probeLinux();
    if (process.platform === 'darwin') return await probeMac();
    return { displays: [], log: [`no display probe for platform ${process.platform}`] };
  } catch (err) {
    return { displays: [], log: [`platform display probe failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
