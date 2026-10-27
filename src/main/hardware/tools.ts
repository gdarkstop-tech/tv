import os from 'node:os';
import path from 'node:path';
import type { ToolInfo } from '../../shared/types';
import { vendorDir } from '../paths';
import { fileExists, run, which } from '../util/exec';

// Locates the external programs NOVA integrates with. NOVA never installs
// anything silently; missing tools are reported with install instructions.

export type ToolName =
  | 'mpv'
  | 'ffprobe'
  | 'ffmpeg'
  | 'scrcpy'
  | 'adb'
  | 'uxplay'
  | 'cec-client'
  | 'ddcutil'
  | 'nvidia-smi'
  | 'xrandr'
  | 'vainfo'
  | 'edge'
  | 'chrome';

const env = (k: string) => process.env[k] ?? '';

function windowsDirs(tool: ToolName): string[] {
  const pf = env('ProgramFiles') || 'C:\\Program Files';
  const pf86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const local = env('LOCALAPPDATA');
  const home = os.homedir();
  const common = [
    path.join(home, 'scoop', 'shims'),
    'C:\\ProgramData\\chocolatey\\bin',
    path.join(local, 'Microsoft', 'WinGet', 'Links'),
  ];
  switch (tool) {
    case 'mpv':
      return [
        path.join(vendorDir(), 'mpv'),
        path.join(pf, 'mpv'),
        path.join(pf, 'MPV Player'),
        path.join(local, 'Programs', 'mpv'),
        path.join(home, 'scoop', 'apps', 'mpv', 'current'),
        ...common,
      ];
    case 'ffprobe':
    case 'ffmpeg':
      return [path.join(vendorDir(), 'ffmpeg', 'bin'), path.join(vendorDir(), 'ffmpeg'), 'C:\\ffmpeg\\bin', ...common];
    case 'scrcpy':
      return [path.join(local, 'Programs', 'scrcpy'), ...common];
    case 'adb':
      return [path.join(local, 'Android', 'Sdk', 'platform-tools'), ...common];
    case 'uxplay':
      return ['C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', ...common];
    case 'cec-client':
      return [path.join(pf, 'Pulse-Eight', 'USB-CEC Adapter'), path.join(pf86, 'Pulse-Eight', 'USB-CEC Adapter')];
    case 'nvidia-smi':
      return ['C:\\Windows\\System32', path.join(pf, 'NVIDIA Corporation', 'NVSMI')];
    case 'edge':
      return [path.join(pf86, 'Microsoft', 'Edge', 'Application'), path.join(pf, 'Microsoft', 'Edge', 'Application')];
    case 'chrome':
      return [path.join(pf, 'Google', 'Chrome', 'Application'), path.join(pf86, 'Google', 'Chrome', 'Application'), path.join(local, 'Google', 'Chrome', 'Application')];
    default:
      return common;
  }
}

function macDirs(tool: ToolName): string[] {
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  if (tool === 'mpv') return [path.join(vendorDir(), 'mpv'), '/Applications/mpv.app/Contents/MacOS', ...dirs];
  if (tool === 'chrome') return ['/Applications/Google Chrome.app/Contents/MacOS'];
  if (tool === 'edge') return ['/Applications/Microsoft Edge.app/Contents/MacOS'];
  return dirs;
}

function linuxDirs(tool: ToolName): string[] {
  const dirs = ['/usr/local/bin', '/usr/bin', '/snap/bin'];
  if (tool === 'mpv') return [path.join(vendorDir(), 'mpv'), ...dirs];
  return dirs;
}

const EXECUTABLE_NAMES: Record<ToolName, Partial<Record<NodeJS.Platform, string[]>> & { default: string[] }> = {
  mpv: { default: ['mpv'] },
  ffprobe: { default: ['ffprobe'] },
  ffmpeg: { default: ['ffmpeg'] },
  scrcpy: { default: ['scrcpy'] },
  adb: { default: ['adb'] },
  uxplay: { default: ['uxplay'] },
  'cec-client': { default: ['cec-client'] },
  ddcutil: { default: ['ddcutil'] },
  'nvidia-smi': { default: ['nvidia-smi'] },
  xrandr: { default: ['xrandr'] },
  vainfo: { default: ['vainfo'] },
  edge: { default: ['microsoft-edge', 'microsoft-edge-stable'], win32: ['msedge'], darwin: ['Microsoft Edge'] },
  chrome: { default: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], win32: ['chrome'], darwin: ['Google Chrome'] },
};

export function locateTool(tool: ToolName, configuredPath?: string | null): string | null {
  if (configuredPath && fileExists(configuredPath)) return configuredPath;
  const names = EXECUTABLE_NAMES[tool][process.platform] ?? EXECUTABLE_NAMES[tool].default;
  const extra = process.platform === 'win32' ? windowsDirs(tool) : process.platform === 'darwin' ? macDirs(tool) : linuxDirs(tool);
  for (const n of names) {
    const found = which(n, extra);
    if (found) return found;
  }
  return null;
}

const VERSION_ARGS: Partial<Record<ToolName, string[]>> = {
  mpv: ['--version'],
  ffprobe: ['-version'],
  ffmpeg: ['-version'],
  scrcpy: ['--version'],
  adb: ['version'],
  uxplay: ['-h'],
  'cec-client': ['--info'],
  ddcutil: ['--version'],
  'nvidia-smi': ['--version'],
  xrandr: ['--version'],
  vainfo: ['--version'],
};

export function parseVersion(tool: ToolName, output: string): string | null {
  const text = output.split(/\r?\n/).slice(0, 6).join('\n');
  const patterns: Partial<Record<ToolName, RegExp>> = {
    mpv: /mpv\s+v?([0-9][^\s]*)/i,
    ffprobe: /ffprobe version\s+(\S+)/i,
    ffmpeg: /ffmpeg version\s+(\S+)/i,
    scrcpy: /scrcpy\s+v?([0-9][^\s]*)/i,
    adb: /Android Debug Bridge version\s+(\S+)/i,
    uxplay: /UxPlay\s+v?([0-9][^\s:]*)/i,
    'cec-client': /libCEC version:\s*([0-9][^\s,]*)/i,
    ddcutil: /ddcutil\s+([0-9][^\s]*)/i,
    'nvidia-smi': /NVIDIA-SMI version\s*:\s*(\S+)/i,
    xrandr: /xrandr program version\s+(\S+)/i,
    vainfo: /vainfo:\s*VA-API version:\s*(\S+)/i,
  };
  const re = patterns[tool];
  const m = re ? text.match(re) : null;
  return m?.[1] ?? null;
}

export async function toolInfo(tool: ToolName, configuredPath?: string | null): Promise<ToolInfo> {
  const p = locateTool(tool, configuredPath);
  if (!p) return { name: tool, found: false, path: null, version: null };
  const args = VERSION_ARGS[tool];
  if (!args) return { name: tool, found: true, path: p, version: null };
  const r = await run(p, args, { timeoutMs: 8000 });
  return { name: tool, found: true, path: p, version: parseVersion(tool, r.stdout + '\n' + r.stderr) };
}

export const INSTALL_HINTS: Record<string, Partial<Record<NodeJS.Platform, string>> & { default: string }> = {
  mpv: {
    win32: 'Install mpv: "scoop install mpv", or download a Windows build linked from https://mpv.io/installation/ and extract it to C:\\Program Files\\mpv (or set its path in Settings → Playback).',
    darwin: 'Install mpv with Homebrew: brew install mpv',
    linux: 'Install mpv from your distribution, e.g. sudo apt install mpv',
    default: 'Install mpv from https://mpv.io/installation/',
  },
  ffprobe: {
    win32: 'Optional: install FFmpeg (scoop install ffmpeg, or winget install Gyan.FFmpeg) for faster library metadata.',
    darwin: 'Optional: brew install ffmpeg',
    linux: 'Optional: sudo apt install ffmpeg',
    default: 'Optional: install FFmpeg for faster library metadata.',
  },
  scrcpy: {
    win32: 'Install scrcpy (scoop install scrcpy, or winget install Genymobile.scrcpy) and enable USB debugging on the Android phone.',
    darwin: 'brew install scrcpy, then enable USB debugging on the Android phone.',
    linux: 'sudo apt install scrcpy (or the snap), then enable USB debugging on the Android phone.',
    default: 'Install scrcpy from https://github.com/Genymobile/scrcpy',
  },
  uxplay: {
    win32: 'UxPlay (AirPlay mirroring receiver) can be built with MSYS2 and needs Apple Bonjour; see docs/SCREEN_MIRRORING.md.',
    darwin: 'brew install uxplay',
    linux: 'sudo apt install uxplay',
    default: 'Install UxPlay from https://github.com/FDH2/UxPlay',
  },
};

export function installHint(tool: string): string | null {
  const h = INSTALL_HINTS[tool];
  if (!h) return null;
  return h[process.platform] ?? h.default;
}
