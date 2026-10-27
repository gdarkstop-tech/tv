import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function hasBinary(name: string): boolean {
  // ffmpeg/ffprobe use -version; most other tools use --version.
  const flag = name.startsWith('ff') ? '-version' : '--version';
  const r = spawnSync(name, [flag], { stdio: 'ignore' });
  return r.status === 0;
}

export const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY);

/** Average R, G, B (0..255) of an image file, decoded with ffmpeg. */
export function imageMean(file: string): { r: number; g: number; b: number } {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  let r = 0;
  let g = 0;
  let b = 0;
  const n = raw.length / 3;
  for (let i = 0; i < raw.length; i += 3) {
    r += raw[i]!;
    g += raw[i + 1]!;
    b += raw[i + 2]!;
  }
  return { r: r / n, g: g / n, b: b / n };
}

/** Mean absolute difference between horizontally adjacent pixels (edge energy). */
export function edgeEnergy(file: string, width: number): number {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < raw.length; i++) {
    if ((i + 1) % width === 0) continue;
    sum += Math.abs(raw[i]! - raw[i + 1]!);
    count++;
  }
  return sum / count;
}

export function makeTestVideo(dir: string, name: string, args: string[]): string {
  const out = path.join(dir, name);
  if (!fs.existsSync(out)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, out]);
  }
  return out;
}
