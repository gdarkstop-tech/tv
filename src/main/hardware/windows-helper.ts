import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { logger } from '../log';
import { dataPaths, resourcePath } from '../paths';

// Client for resources/windows/nova-helper.ps1: a persistent PowerShell
// process that hosts allow-listed native probes (DisplayConfig, EDID,
// DDC/CI, Core Audio volume, GPU counters).

const log = logger('win-helper');

export type WinHelperOp =
  | 'ping'
  | 'system'
  | 'gpus'
  | 'displays'
  | 'ddcProbe'
  | 'ddcSet'
  | 'volumeGet'
  | 'volumeSet'
  | 'muteSet'
  | 'gpuUsage'
  | 'processStats';

export interface WinDisplayPath {
  GdiName: string | null;
  AdapterName: string | null;
  FriendlyName: string | null;
  MonitorDevicePath: string | null;
  OutputTechnology: string;
  OutputTechnologyCode: number;
  X: number;
  Y: number;
  Width: number;
  Height: number;
  RefreshHz: number;
  AdvancedColorQueried: boolean;
  AdvancedColorSupported: boolean;
  AdvancedColorEnabled: boolean;
  WideColorEnforced: boolean;
  AdvancedColorForceDisabled: boolean;
  BitsPerColorChannel: number;
  ColorEncoding: number;
  EdidBase64: string | null;
  EdidRegistryKey: string | null;
  Current: { Width: number; Height: number; RefreshHz: number; BitsPerPixel: number; Interlaced: boolean } | null;
  Modes: Array<{ Width: number; Height: number; RefreshHz: number; BitsPerPixel: number; Interlaced: boolean }> | null;
  Errors: string[] | null;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class WindowsHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private failures = 0;

  get supported(): boolean {
    return process.platform === 'win32';
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const script = resourcePath('windows', 'nova-helper.ps1');
      const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const proc = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        env: { ...process.env, NOVA_HELPER_CACHE: path.join(dataPaths.cache(), 'helper') },
      });
      this.proc = proc;
      const startTimer = setTimeout(() => reject(new Error('Windows helper did not start within 30s')), 30000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg: { id: number; ok: boolean; result?: unknown; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            log.warn('unparseable helper output', line.slice(0, 200));
            continue;
          }
          if (msg.id === 0) {
            clearTimeout(startTimer);
            resolve();
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? 'helper error'));
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d: string) => log.warn('helper stderr', d.slice(0, 500)));
      proc.on('exit', (code) => {
        clearTimeout(startTimer);
        log.warn('helper exited', { code });
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Windows helper exited'));
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(new Error(`Windows helper exited with code ${code}`));
      });
      proc.on('error', (err) => {
        clearTimeout(startTimer);
        reject(err);
      });
    });
    return this.ready;
  }

  async call<T>(op: WinHelperOp, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    if (!this.supported) throw new Error('Windows helper is only available on Windows');
    if (this.failures > 5) throw new Error('Windows helper disabled after repeated failures');
    try {
      await this.start();
    } catch (err) {
      this.failures++;
      this.ready = null;
      throw err;
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows helper op ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc?.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}

export const windowsHelper = new WindowsHelper();
