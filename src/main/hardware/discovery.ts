import fs from 'node:fs';
import os from 'node:os';
import { app, screen, type Display } from 'electron';
import type { Capability, ConnectionType, DisplayInfo, DisplayMode, GpuInfo, HardwareReport, Platform, ToolInfo } from '../../shared/types';
import { privateIpv4Addresses } from '../remote/net';
import { run } from '../util/exec';
import { mpvAudioDevices, mpvHwdecMethods, runDecodeTests } from './decoders';
import { edidKey, parseEdid, supportedEotfs } from './edid';
import { probePlatformDisplays, type PlatformDisplay } from './platform-probes';
import { locateTool, toolInfo, type ToolName } from './tools';
import { windowsHelper } from './windows-helper';

// Phase 0 discovery: builds a HardwareReport describing what this machine and
// the connected television actually report. Every claim records its source and
// whether NOVA verified it or merely read it from the OS/EDID.

const VENDORS: Record<number, string> = {
  0x8086: 'Intel',
  0x10de: 'NVIDIA',
  0x1002: 'AMD',
  0x1022: 'AMD',
  0x106b: 'Apple',
  0x1414: 'Microsoft (Basic Display Adapter)',
  0x15ad: 'VMware (virtual)',
  0x1af4: 'virtio (virtual)',
  0x1234: 'QEMU (virtual)',
  0x80ee: 'VirtualBox (virtual)',
};

export function platformName(): Platform {
  const p = process.platform;
  return p === 'win32' || p === 'linux' || p === 'darwin' ? p : 'other';
}

function cap<T>(value: T, verification: Capability['verification'], source: string, note?: string): Capability<T> {
  return note ? { value, verification, source, note } : { value, verification, source };
}

function physicalRect(d: Display): { x: number; y: number; width: number; height: number } {
  if (process.platform === 'win32' && typeof screen.dipToScreenRect === 'function') {
    try {
      return screen.dipToScreenRect(null, d.bounds);
    } catch {
      // fall through
    }
  }
  const s = d.scaleFactor || 1;
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), width: Math.round(d.size.width * s), height: Math.round(d.size.height * s) };
}

export function matchPlatformDisplay(
  rect: { x: number; y: number; width: number; height: number },
  candidates: PlatformDisplay[],
  used: Set<PlatformDisplay>,
): PlatformDisplay | null {
  const free = candidates.filter((c) => !used.has(c));
  const exact = free.find((c) => c.rect && c.rect.x === rect.x && c.rect.y === rect.y);
  if (exact) return exact;
  const near = free.find((c) => c.rect && Math.abs(c.rect.x - rect.x) <= 2 && Math.abs(c.rect.y - rect.y) <= 2);
  if (near) return near;
  const rectless = free.filter((c) => !c.rect);
  if (rectless.length === 1 && free.length === 1) return rectless[0]!;
  return null;
}

function dedupeModes(modes: DisplayMode[]): DisplayMode[] {
  const seen = new Map<string, DisplayMode>();
  for (const m of modes) {
    const k = `${m.width}x${m.height}@${Math.round(m.refreshHz)}`;
    if (!seen.has(k)) seen.set(k, m);
  }
  return [...seen.values()].sort((a, b) => b.width * b.height - a.width * a.height || b.refreshHz - a.refreshHz);
}

export function buildDisplayInfo(d: Display, primaryId: number, pd: PlatformDisplay | null): DisplayInfo {
  const edid = pd?.edid ? parseEdid(pd.edid) : null;
  const scale = d.scaleFactor || 1;
  const currentMode: DisplayMode = pd?.current ?? {
    width: Math.round(d.size.width * scale),
    height: Math.round(d.size.height * scale),
    refreshHz: d.displayFrequency || 0,
  };
  if (!currentMode.refreshHz && d.displayFrequency) currentMode.refreshHz = d.displayFrequency;

  let connection: Capability<ConnectionType>;
  if (pd && pd.connection !== 'unknown') connection = cap(pd.connection, 'reported', pd.connectionSource);
  else if (d.internal) connection = cap<ConnectionType>('internal', 'reported', 'Electron display.internal');
  else connection = cap<ConnectionType>('unknown', 'unknown', 'not reported by the operating system');

  let nativeResolution: DisplayInfo['nativeResolution'];
  if (edid?.nativeMode) {
    nativeResolution = cap({ width: edid.nativeMode.width, height: edid.nativeMode.height }, 'reported', 'EDID preferred/native timing');
  } else {
    nativeResolution = cap(null, 'unknown', 'no EDID available');
  }

  const eotfs = supportedEotfs(edid);
  const edidHdr = Boolean(edid?.cea?.hdr && (edid.cea.hdr.eotfPq || edid.cea.hdr.eotfHlg));
  let displaySupportsHdr: Capability<boolean>;
  let osHdrEnabled: Capability<boolean>;
  if (pd?.hdr) {
    displaySupportsHdr = cap(pd.hdr.supported, 'reported', pd.hdr.source);
    osHdrEnabled = cap(pd.hdr.enabled, 'reported', pd.hdr.source);
  } else {
    displaySupportsHdr = edid ? cap(edidHdr, 'reported', 'EDID HDR static metadata block') : cap(false, 'unknown', 'no EDID available');
    const cs = (d.colorSpace ?? '').toUpperCase();
    osHdrEnabled = cs.includes('PQ') || cs.includes('HLG') ? cap(true, 'reported', 'Electron display.colorSpace') : cap(false, 'unknown', 'OS HDR state not reported on this platform');
  }

  const notes: string[] = [];
  const native = nativeResolution.value;
  if (native && (currentMode.width !== native.width || currentMode.height !== native.height)) {
    notes.push(
      `Running at ${currentMode.width}x${currentMode.height}, but the display reports ${native.width}x${native.height} as its native timing. ` +
        'Set the operating system display resolution to the native mode for the sharpest picture (NOVA does not change it for you).',
    );
  }
  if (edid?.maxMode && native && edid.maxMode.width * edid.maxMode.height > native.width * native.height) {
    notes.push(`The display also advertises ${edid.maxMode.width}x${edid.maxMode.height}@${Math.round(edid.maxMode.refreshHz)}Hz.`);
  }
  if (edid && !edid.checksumOk) notes.push('EDID checksum mismatch: the display reported partially corrupted data.');
  if (connection.value === 'hdmi') {
    notes.push('Many televisions overscan HDMI input by default. If the edges of the NOVA calibration pattern are cut off, enable "Just Scan", "Screen Fit" or "1:1 pixel" on the TV.');
  }
  for (const e of pd?.errors ?? []) notes.push(`Probe: ${e}`);

  const label = d.label || pd?.name || edid?.monitorName || (d.internal ? 'Built-in display' : `Display ${d.id}`);
  const key = (edid && edidKey(edid)) || `${label}-${currentMode.width}x${currentMode.height}`.replace(/\s+/g, '_');

  return {
    id: d.id,
    key,
    label,
    internal: connection.value === 'internal' || d.internal,
    primary: d.id === primaryId,
    bounds: { ...d.bounds },
    scaleFactor: scale,
    currentMode,
    rotation: d.rotation,
    colorDepth: d.colorDepth,
    colorSpace: d.colorSpace ?? '',
    connection,
    nativeResolution,
    availableModes: dedupeModes(pd?.modes ?? []),
    hdr: { displaySupportsHdr, osHdrEnabled, supportedEotfs: eotfs },
    ddcci: cap(false, 'unknown', 'not probed'),
    edid,
    notes,
  };
}

/** Fast display snapshot (no decode tests); used at startup and on hot-plug. */
export async function discoverDisplays(): Promise<{ displays: DisplayInfo[]; log: string[] }> {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const probe = await probePlatformDisplays();
  const used = new Set<PlatformDisplay>();
  const displays = all.map((d) => {
    const pd = matchPlatformDisplay(physicalRect(d), probe.displays, used);
    if (pd) used.add(pd);
    return buildDisplayInfo(d, primary.id, pd);
  });
  return { displays, log: probe.log };
}

async function gpuList(log: string[]): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: Array<{ vendorId: number; deviceId: number; active: boolean; driverVersion?: string; deviceString?: string }> };
    for (const g of info.gpuDevice ?? []) {
      gpus.push({
        vendor: VENDORS[g.vendorId] ?? `vendor 0x${g.vendorId.toString(16)}`,
        name: g.deviceString || `device 0x${g.deviceId.toString(16)}`,
        driverVersion: g.driverVersion ?? null,
        memoryMB: null,
        active: g.active,
        source: 'Chromium GPU info',
      });
    }
  } catch (err) {
    log.push(`Chromium GPU info unavailable: ${String(err)}`);
  }
  if (process.platform === 'win32') {
    try {
      const list = await windowsHelper.call<Array<{ name: string; vendor: string; driverVersion: string; adapterRamBytes: number | null }>>('gpus');
      for (const g of Array.isArray(list) ? list : [list]) {
        const existing = gpus.find((x) => g.name && (x.name === g.name || g.name.toLowerCase().includes(x.vendor.toLowerCase())));
        const entry: GpuInfo = {
          vendor: g.vendor ?? 'unknown',
          name: g.name ?? 'unknown',
          driverVersion: g.driverVersion ?? null,
          // AdapterRAM is a 32-bit field and caps at 4 GB; report it as such.
          memoryMB: g.adapterRamBytes ? Math.round(g.adapterRamBytes / 1048576) : null,
          active: existing?.active ?? false,
          source: 'Windows Win32_VideoController',
        };
        if (existing) Object.assign(existing, { name: entry.name, driverVersion: entry.driverVersion, memoryMB: entry.memoryMB, source: 'Chromium GPU info + Win32_VideoController' });
        else gpus.push(entry);
      }
    } catch (err) {
      log.push(`Win32_VideoController query failed: ${String(err)}`);
    }
  } else if (process.platform === 'linux') {
    try {
      for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
        const base = `/sys/class/drm/${card}/device`;
        const vendor = parseInt(fs.readFileSync(`${base}/vendor`, 'utf8').trim(), 16);
        const uevent = fs.readFileSync(`${base}/uevent`, 'utf8');
        const driver = uevent.match(/DRIVER=(\S+)/)?.[1] ?? null;
        if (!gpus.some((g) => g.vendor === VENDORS[vendor])) {
          gpus.push({ vendor: VENDORS[vendor] ?? `vendor 0x${vendor.toString(16)}`, name: `${card} (${driver ?? 'unknown driver'})`, driverVersion: null, memoryMB: null, active: true, source: 'Linux DRM sysfs' });
        }
      }
    } catch {
      log.push('no DRM GPU devices in /sys/class/drm');
    }
  }
  return gpus;
}

async function detectVm(log: string[]): Promise<Capability<boolean>> {
  const vmPattern = /virtual|vmware|virtualbox|kvm|qemu|xen|hyper-v|parallels|firecracker|bochs/i;
  try {
    if (process.platform === 'win32') {
      const s = await windowsHelper.call<{ manufacturer: string; model: string }>('system');
      const text = `${s.manufacturer} ${s.model}`;
      return cap(vmPattern.test(text), 'reported', `Win32_ComputerSystem: ${text}`);
    }
    if (process.platform === 'linux') {
      const read = (f: string) => {
        try {
          return fs.readFileSync(f, 'utf8').trim();
        } catch {
          return '';
        }
      };
      const text = `${read('/sys/class/dmi/id/sys_vendor')} ${read('/sys/class/dmi/id/product_name')}`.trim();
      const hypervisorFlag = /\bhypervisor\b/.test(read('/proc/cpuinfo'));
      return cap(vmPattern.test(text) || hypervisorFlag, 'reported', text ? `DMI: ${text}` : 'cpuinfo hypervisor flag');
    }
  } catch (err) {
    log.push(`VM detection failed: ${String(err)}`);
  }
  return cap(false, 'unknown', 'not determined');
}

async function osDescription(): Promise<string> {
  if (process.platform === 'linux') {
    try {
      const rel = fs.readFileSync('/etc/os-release', 'utf8');
      return rel.match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? 'Linux';
    } catch {
      return 'Linux';
    }
  }
  if (process.platform === 'win32') {
    try {
      const s = await windowsHelper.call<{ osCaption: string; osBuild: string }>('system');
      return `${s.osCaption} (build ${s.osBuild})`;
    } catch {
      return `Windows ${os.release()}`;
    }
  }
  if (process.platform === 'darwin') {
    const r = await run('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 5000 });
    return `macOS ${r.stdout.trim()}`;
  }
  return os.type();
}

async function probeDdc(displays: DisplayInfo[], gdiByKey: Map<string, string>, log: string[]): Promise<void> {
  if (process.platform === 'win32') {
    for (const d of displays) {
      const gdi = gdiByKey.get(d.key);
      if (!gdi || d.internal) continue;
      try {
        const r = await windowsHelper.call<{ Supported: boolean; Error: string | null; Brightness: number }>('ddcProbe', { gdiName: gdi }, 15000);
        d.ddcci = r.Supported
          ? cap(true, 'verified', 'DDC/CI brightness read succeeded (dxva2)')
          : cap(false, 'verified', 'DDC/CI probe (dxva2)', r.Error ?? 'display did not answer');
      } catch (err) {
        d.ddcci = cap(false, 'unknown', 'DDC/CI probe failed', String(err));
      }
    }
  } else if (process.platform === 'linux') {
    const ddcutil = locateTool('ddcutil');
    if (!ddcutil) {
      log.push('ddcutil not installed: DDC/CI not probed');
      return;
    }
    const r = await run(ddcutil, ['detect', '--terse'], { timeoutMs: 20000 });
    log.push(`ddcutil detect: ${r.ok ? 'ok' : r.error}`);
    const found = /Display \d+/.test(r.stdout);
    for (const d of displays.filter((x) => !x.internal)) {
      d.ddcci = cap(found, found ? 'reported' : 'verified', 'ddcutil detect');
    }
  }
}

export async function buildHardwareReport(opts: { mpvPath: string | null; runDecode: boolean }): Promise<HardwareReport> {
  const probeLog: string[] = [];
  const startedAt = Date.now();
  const { displays, log: dlog } = await discoverDisplays();
  probeLog.push(...dlog);

  // Map display key → GDI name for Windows DDC probing.
  const gdiByKey = new Map<string, string>();
  if (process.platform === 'win32') {
    const probe = await probePlatformDisplays();
    const used = new Set<PlatformDisplay>();
    for (const d of screen.getAllDisplays()) {
      const pd = matchPlatformDisplay(physicalRect(d), probe.displays, used);
      if (pd) used.add(pd);
      const info = displays.find((x) => x.id === d.id);
      if (pd?.gdiName && info) gdiByKey.set(info.key, pd.gdiName);
    }
  }
  await probeDdc(displays, gdiByKey, probeLog);

  const cpus = os.cpus();
  const toolNames: ToolName[] = ['mpv', 'ffprobe', 'ffmpeg', 'scrcpy', 'adb', 'uxplay', 'cec-client', 'ddcutil', 'nvidia-smi', 'vainfo', 'edge', 'chrome'];
  const tools: ToolInfo[] = [];
  for (const t of toolNames) {
    if (t === 'mpv' && opts.mpvPath) tools.push(await toolInfo('mpv', opts.mpvPath));
    else tools.push(await toolInfo(t));
  }
  const mpv = tools.find((t) => t.name === 'mpv');
  const mpvPath = mpv?.found ? mpv.path : null;

  let hwdecMethods: string[] = [];
  let decodeTests: HardwareReport['decoding']['tests'] = [];
  let audioDevices: HardwareReport['audioDevices'] = [];
  if (mpvPath) {
    hwdecMethods = await mpvHwdecMethods(mpvPath);
    audioDevices = await mpvAudioDevices(mpvPath);
    if (opts.runDecode) decodeTests = await runDecodeTests(mpvPath);
  } else probeLog.push('mpv not found: decode tests and audio device listing skipped');

  const featureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  const gpus = await gpuList(probeLog);
  const vm = await detectVm(probeLog);

  const external = displays.filter((d) => !d.internal && d.connection.value !== 'virtual');
  const limitations: string[] = [];
  if (external.length === 0) limitations.push('No external display (television) detected. Connect the TV over HDMI and choose "Extend" or "Second screen only" in the OS display settings.');
  if (!displays.some((d) => d.connection.value === 'hdmi')) limitations.push('No display reported an HDMI connection type by the operating system.');
  if (!mpvPath) limitations.push('mpv was not found, so video and music playback are unavailable until it is installed.');
  const sw = decodeTests.filter((t) => t.verification === 'verified' && !t.hardware).map((t) => t.label);
  if (sw.length) limitations.push(`Hardware decoding not available (software/CPU decoding) for: ${sw.join(', ')}.`);
  if (!displays.some((d) => d.hdr.osHdrEnabled.value)) limitations.push('HDR output is not enabled/available on any display; HDR videos are tone-mapped to SDR by NOVA Vision.');
  if (!displays.some((d) => d.ddcci.value)) limitations.push('DDC/CI control of the TV was not verified; physical TV brightness/contrast must be set with the TV remote.');
  if (!tools.find((t) => t.name === 'cec-client')?.found) limitations.push('HDMI-CEC is unavailable: laptop HDMI ports normally do not implement CEC; a USB-CEC adapter (libCEC) is required.');
  if (!tools.find((t) => t.name === 'uxplay')?.found) limitations.push('iPhone screen mirroring (AirPlay) needs the UxPlay receiver, which was not found.');
  if (!tools.find((t) => t.name === 'scrcpy')?.found) limitations.push('Android screen mirroring needs scrcpy, which was not found.');
  if (vm.value) limitations.push('This machine appears to be a virtual machine: GPU, display and performance results are not representative of real hardware.');
  if (gpus.length === 0 || (featureStatus.gpu_compositing ?? '').startsWith('disabled')) limitations.push('GPU compositing is disabled or no GPU was detected; UI and video rendering fall back to software.');

  probeLog.push(`report built in ${Date.now() - startedAt} ms`);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    environment: {
      platform: platformName(),
      osRelease: os.release(),
      osDescription: await osDescription(),
      arch: process.arch,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      isVirtualMachine: vm,
    },
    cpu: {
      model: cpus[0]?.model?.trim() ?? 'unknown',
      logicalCores: cpus.length,
      physicalCores: null,
      speedMHz: cpus[0]?.speed ?? 0,
    },
    memory: { totalMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) },
    gpus,
    chromiumGpu: { featureStatus, videoDecodeAcceleration: featureStatus.video_decode ?? 'unknown' },
    displays,
    externalDisplayDetected: external.length > 0,
    decoding: { hwdecMethodsCompiledIntoMpv: hwdecMethods, tests: decodeTests },
    audioDevices,
    tools,
    network: privateIpv4Addresses().map((n) => ({ interface: n.iface, address: n.address, private: true })),
    limitations,
    probeLog,
  };
}
