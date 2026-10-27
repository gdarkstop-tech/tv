import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MpvIpcClient } from '../../src/main/player/mpv-ipc';
import { buildVisionState, shaderOptsString } from '../../src/main/vision/mapping';
import { NEUTRAL_ADJUSTMENTS } from '../../src/shared/picture';
import { edgeEnergy, hasBinary, hasDisplay, imageMean, makeTestVideo } from '../helpers/media';

// Verifies that NOVA Vision adjustments produce measurable changes in the
// pixels mpv actually renders (window screenshots include shaders/filters).

const canRun = hasBinary('mpv') && hasBinary('ffmpeg') && hasDisplay;
const shaderDir = path.resolve(__dirname, '../../resources/shaders');

describe.skipIf(!canRun)('NOVA Vision Engine against real mpv', () => {
  let dir: string;
  let mpv: ChildProcess;
  let ipc: MpvIpcClient;
  let pattern: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-vision-'));
    pattern = makeTestVideo(dir, 'pattern.png', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1']);
    const sock = path.join(dir, 'mpv.sock');
    mpv = spawn(
      'mpv',
      [
        '--no-config',
        '--idle=yes',
        '--force-window=yes',
        '--keep-open=yes',
        '--image-display-duration=inf',
        '--vo=gpu-next',
        '--gpu-sw=yes',
        '--ao=null',
        '--geometry=640x360',
        '--osd-level=0',
        `--input-ipc-server=${sock}`,
      ],
      { stdio: 'ignore' },
    );
    ipc = new MpvIpcClient(sock);
    await ipc.connect(15000);
    await ipc.command('loadfile', pattern);
    await waitFor(async () => (await ipc.getOr<string | null>('path', null)) !== null);
    await sleep(800);
  });

  afterAll(() => {
    ipc?.close();
    mpv?.kill();
  });

  async function shot(name: string): Promise<string> {
    await sleep(500);
    const file = path.join(dir, name);
    await ipc.command('screenshot-to-file', file, 'window');
    return file;
  }

  async function apply(adjust: Partial<typeof NEUTRAL_ADJUSTMENTS>): Promise<void> {
    const state = buildVisionState({ ...NEUTRAL_ADJUSTMENTS, deband: false, ...adjust }, 'balanced', {
      shaderDir,
      shadersSupported: true,
      hdrPassthrough: false,
      hardwareDecoding: 'off',
      lowLatency: false,
    });
    for (const [k, v] of state.properties) {
      try {
        await ipc.set(k, v);
      } catch (err) {
        throw new Error(`property ${k}=${String(v)} rejected: ${String(err)}`);
      }
    }
    await ipc.command('change-list', 'glsl-shaders', 'clr', '');
    for (const s of state.shaders) await ipc.command('change-list', 'glsl-shaders', 'append', s);
    await ipc.set('glsl-shader-opts', shaderOptsString(state.shaderOpts));
  }

  it('every mapped property is accepted by mpv', async () => {
    await apply({});
    const base = imageMean(await shot('base.png'));
    expect(base.r).toBeGreaterThan(10);
  });

  it('brightness +30 raises the rendered luminance', async () => {
    await apply({});
    const base = imageMean(await shot('b0.png'));
    await apply({ brightness: 30 });
    const bright = imageMean(await shot('b30.png'));
    const lum = (m: { r: number; g: number; b: number }) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
    expect(lum(bright)).toBeGreaterThan(lum(base) + 10);
  });

  it('saturation -50 moves colours toward grey', async () => {
    await apply({});
    const base = imageMean(await shot('s0.png'));
    await apply({ saturation: -50 });
    const desat = imageMean(await shot('s-50.png'));
    const spread = (m: { r: number; g: number; b: number }) => Math.max(m.r, m.g, m.b) - Math.min(m.r, m.g, m.b);
    expect(spread(desat)).toBeLessThan(spread(base));
  });

  it('colour temperature shader warms and cools the image', async () => {
    await apply({});
    const base = imageMean(await shot('t0.png'));
    await apply({ colorTemperature: -10 });
    const warm = imageMean(await shot('t-10.png'));
    await apply({ colorTemperature: 10 });
    const cool = imageMean(await shot('t10.png'));
    expect(warm.b).toBeLessThan(base.b - 5);
    expect(Math.abs(warm.r - base.r)).toBeLessThan(2);
    expect(cool.r).toBeLessThan(base.r - 5);
    expect(Math.abs(cool.b - base.b)).toBeLessThan(2);
  });

  it('sharpening shader increases edge energy', async () => {
    await apply({});
    const soft = edgeEnergy(await shot('sh0.png'), 640);
    await apply({ sharpness: 10 });
    const sharp = edgeEnergy(await shot('sh10.png'), 640);
    expect(sharp).toBeGreaterThan(soft * 1.03);
  });

  it('noise reduction filter is accepted by the filter chain', async () => {
    await apply({ noiseReduction: 'medium' });
    const vf = await ipc.get<Array<{ label?: string; name: string }>>('vf');
    // vf is applied only via the player service; here we set it directly.
    expect(Array.isArray(vf)).toBe(true);
    await ipc.set('vf', '@novanr:lavfi=[hqdn3d=4:3:6:4.5]');
    const after = await ipc.get<Array<{ label?: string; name: string }>>('vf');
    expect(after.some((f) => f.label === 'novanr')).toBe(true);
    await ipc.set('vf', '');
  });
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for condition');
}
