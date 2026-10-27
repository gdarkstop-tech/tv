import net from 'node:net';
import { EventEmitter } from 'node:events';

// Minimal, robust client for mpv's JSON IPC protocol
// (https://mpv.io/manual/stable/#json-ipc). One newline-delimited JSON
// message per line; replies carry the request_id we sent.

export interface MpvEvent {
  event: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export class MpvCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly mpvError: string,
  ) {
    super(`mpv command "${command}" failed: ${mpvError}`);
    this.name = 'MpvCommandError';
  }
}

export class MpvIpcClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private observers = new Map<number, string>();
  private nextObserveId = 1;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly timeoutMs = 5000,
  ) {
    super();
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Connect, retrying until mpv has created the socket/pipe. */
  async connect(totalWaitMs = 8000): Promise<void> {
    const deadline = Date.now() + totalWaitMs;
    let lastError: unknown = null;
    while (Date.now() < deadline && !this.closed) {
      try {
        await this.tryConnect();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`Could not connect to mpv IPC at ${this.path}: ${String(lastError)}`);
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.path);
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.off('error', onError);
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', (err) => this.emit('ipc-error', err));
        sock.on('close', () => this.onClose());
        this.socket = sock;
        resolve();
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Guard against a runaway peer: mpv messages are small.
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.buffer = '';
      this.emit('ipc-error', new Error('mpv IPC buffer overflow'));
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.request_id === 'number' && this.pending.has(msg.request_id) && !('event' in msg)) {
      const p = this.pending.get(msg.request_id)!;
      this.pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.error === 'success') p.resolve(msg.data);
      else p.reject(new MpvCommandError(p.command, String(msg.error)));
      return;
    }
    if (typeof msg.event === 'string') {
      const evt = msg as MpvEvent;
      if (evt.event === 'property-change' && typeof evt.name === 'string') {
        this.emit('property', evt.name, evt.data);
      }
      this.emit('event', evt);
    }
  }

  private onClose(): void {
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('mpv IPC connection closed'));
    }
    this.pending.clear();
    this.emit('close');
  }

  command(...args: unknown[]): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('mpv IPC not connected'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ command: args, request_id: id }) + '\n';
    const name = String(args[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv command "${name}" timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: name });
      this.socket!.write(payload);
    });
  }

  get<T = unknown>(property: string): Promise<T> {
    return this.command('get_property', property) as Promise<T>;
  }

  /** Get a property, returning a fallback instead of throwing when unavailable. */
  async getOr<T>(property: string, fallback: T): Promise<T> {
    try {
      const v = await this.get<T>(property);
      return v === null || v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  set(property: string, value: unknown): Promise<unknown> {
    return this.command('set_property', property, value);
  }

  async observe(property: string): Promise<number> {
    const id = this.nextObserveId++;
    this.observers.set(id, property);
    await this.command('observe_property', id, property);
    return id;
  }

  close(): void {
    this.closed = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
