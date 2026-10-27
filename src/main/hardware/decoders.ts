import fs from 'node:fs';
import type { DecodeTestResult } from '../../shared/types';
import { resourcePath } from '../paths';
import { run } from '../util/exec';

// Hardware decode verification: instead of trusting driver claims, NOVA
// decodes short bundled clips with mpv and records which decoder was used.

export const DECODE_SAMPLES: Array<{ codec: string; label: string; file: string }> = [
  { codec: 'h264', label: 'H.264 / AVC 8-bit 720p', file: 'h264-720p.mp4' },
  { codec: 'hevc', label: 'HEVC / H.265 8-bit 720p', file: 'hevc-720p.mp4' },
  { codec: 'hevc-10bit', label: 'HEVC 10-bit HDR10 1080p', file: 'hevc10-hdr10-1080p.mp4' },
  { codec: 'vp9', label: 'VP9 720p', file: 'vp9-720p.webm' },
  { codec: 'av1', label: 'AV1 720p', file: 'av1-720p.mp4' },
];

export function parseHwdecHelp(text: string): string[] {
  const methods = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+([a-z0-9_-]+)\s+\(/i);
    if (m && m[1] !== 'auto') methods.add(m[1]!);
  }
  return [...methods].sort();
}

export function parseDecoderUsed(text: string): { hardware: boolean; method: string | null } | null {
  let result: { hardware: boolean; method: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const hw = line.match(/Using hardware decoding \(([^)]+)\)/);
    if (hw) result = { hardware: true, method: hw[1]! };
    else if (/Using software decoding/.test(line)) result = { hardware: false, method: null };
  }
  return result;
}

export async function mpvHwdecMethods(mpvPath: string): Promise<string[]> {
  const r = await run(mpvPath, ['--no-config', '--hwdec=help'], { timeoutMs: 10000 });
  return parseHwdecHelp(r.stdout + '\n' + r.stderr);
}

export async function runDecodeTests(mpvPath: string): Promise<DecodeTestResult[]> {
  const results: DecodeTestResult[] = [];
  for (const s of DECODE_SAMPLES) {
    const file = resourcePath('test-media', s.file);
    if (!fs.existsSync(file)) {
      results.push({ codec: s.codec, label: s.label, sample: s.file, hardware: false, method: null, verification: 'unknown', note: 'sample clip missing' });
      continue;
    }
    const r = await run(
      mpvPath,
      ['--no-config', '--vo=null', '--ao=null', '--hwdec=auto-copy', '--frames=12', '--msg-level=all=error,vd=v', file],
      { timeoutMs: 25000 },
    );
    const used = parseDecoderUsed(r.stdout + '\n' + r.stderr);
    if (!used) {
      results.push({
        codec: s.codec,
        label: s.label,
        sample: s.file,
        hardware: false,
        method: null,
        verification: 'unknown',
        note: r.timedOut ? 'decode test timed out' : 'could not determine decoder (mpv output not recognised)',
      });
      continue;
    }
    results.push({
      codec: s.codec,
      label: s.label,
      sample: s.file,
      hardware: used.hardware,
      method: used.method,
      verification: 'verified',
      note: used.hardware ? `decoded by ${used.method}` : 'decoded in software (CPU)',
    });
  }
  return results;
}

export function parseAudioDevices(text: string): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+'([^']+)'\s+\((.*)\)\s*$/);
    if (m) out.push({ name: m[1]!, description: m[2]! });
  }
  return out;
}

export async function mpvAudioDevices(mpvPath: string): Promise<Array<{ name: string; description: string }>> {
  const r = await run(mpvPath, ['--no-config', '--audio-device=help'], { timeoutMs: 10000 });
  return parseAudioDevices(r.stdout + '\n' + r.stderr);
}
