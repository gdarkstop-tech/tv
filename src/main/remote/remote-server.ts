import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  authEnvelopeSchema,
  authMessage,
  commandEnvelopeSchema,
  commandMessage,
  pairRequestSchema,
  REMOTE_PROTOCOL_VERSION,
  remoteCommandSchema,
  sessionKeyMessage,
  type RemoteCommand,
  type RemoteNowPlaying,
  type ServerMessage,
} from '../../shared/remote-protocol';
import type { PairedDevice } from '../../shared/types';
import type { NovaDatabase } from '../db';
import { logger } from '../log';
import { isAllowedHost, isLocalNetworkAddress, normalizeAddress, privateIpv4Addresses } from './net';
import { b64url, hmac, PairingManager, timingSafeEqualB64 } from './pairing';
import { FailureBan, KeyedRateLimiter, TokenBucket } from './rate-limit';

const log = logger('remote');

/** Encrypts device secrets at rest (Electron safeStorage → DPAPI/Keychain/libsecret). */
export interface SecretBox {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export const plaintextSecretBox: SecretBox = {
  available: false,
  encrypt: (s) => s,
  decrypt: (s) => s,
};

export interface RemoteHandlers {
  tvName(): string;
  nowPlaying(): RemoteNowPlaying;
  command(cmd: RemoteCommand, device: { id: string; name: string }): Promise<void>;
  onPaired?(device: { id: string; name: string }): void;
}

interface Session {
  ws: WebSocket;
  ip: string;
  nonce: string;
  deviceId: string | null;
  deviceName: string | null;
  key: Buffer | null;
  lastSeq: number;
  bucket: TokenBucket;
  dropped: number;
  authTimer: NodeJS.Timeout | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const MAX_SOCKETS = 8;
const MAX_BODY = 4096;

export class RemoteServer extends EventEmitter {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Set<Session>();
  readonly pairing = new PairingManager();
  private httpLimiter = new KeyedRateLimiter(60, 2);
  private pairLimiter: KeyedRateLimiter;
  private authBan = new FailureBan(5, 60_000, 5 * 60_000);
  private listeningPort: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: NovaDatabase,
    private readonly staticDir: string,
    private readonly handlers: RemoteHandlers,
    private readonly secrets: SecretBox = plaintextSecretBox,
    options: { pairRequestsPerMinute?: number } = {},
  ) {
    super();
    const perMinute = options.pairRequestsPerMinute ?? 10;
    this.pairLimiter = new KeyedRateLimiter(perMinute, perMinute / 60);
  }

  get port(): number | null {
    return this.listeningPort;
  }

  get error(): string | null {
    return this.lastError;
  }

  get connectedDeviceIds(): Set<string> {
    return new Set([...this.sessions].filter((s) => s.deviceId).map((s) => s.deviceId!));
  }

  urls(): string[] {
    if (!this.listeningPort) return [];
    const ips = privateIpv4Addresses().map((a) => `http://${a.address}:${this.listeningPort}/`);
    return [...ips, `http://${os.hostname().toLowerCase()}.local:${this.listeningPort}/`];
  }

  devices(): PairedDevice[] {
    const connected = this.connectedDeviceIds;
    return this.db.devices().map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, connected: connected.has(d.id) }));
  }

  async start(port: number, host = '0.0.0.0'): Promise<void> {
    await this.stop();
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.on('connection', (sock: net.Socket) => {
      // Defence in depth: refuse anything that is not on the local network.
      if (!isLocalNetworkAddress(sock.remoteAddress)) {
        log.warn('rejected non-local connection', { ip: normalizeAddress(sock.remoteAddress) });
        sock.destroy();
      }
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
      const ip = normalizeAddress(req.socket.remoteAddress);
      const url = new URL(req.url ?? '/', 'http://x');
      const origin = req.headers.origin;
      const host = req.headers.host;
      const originOk = !origin || (host !== undefined && (origin === `http://${host}` || origin === `https://${host}`));
      if (url.pathname !== '/ws' || !isAllowedHost(host) || !originOk || this.authBan.isBanned(ip) || this.sessions.size >= MAX_SOCKETS || !this.httpLimiter.take(ip)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, ip));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((err: NodeJS.ErrnoException) => {
      this.lastError = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message;
      throw err;
    });
    this.server = server;
    this.wss = wss;
    const addr = server.address();
    this.listeningPort = typeof addr === 'object' && addr ? addr.port : port;
    this.lastError = null;
    log.info('remote server listening', { port: this.listeningPort });
  }

  async stop(): Promise<void> {
    for (const s of this.sessions) s.ws.close(1001, 'server stopping');
    this.sessions.clear();
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // ---------------------------------------------------------------- HTTP

  private securityHeaders(res: http.ServerResponse, host: string | undefined): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const wsHost = host && isAllowedHost(host) ? ` ws://${host}` : '';
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${wsHost}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const ip = normalizeAddress(req.socket.remoteAddress);
    const host = req.headers.host;
    this.securityHeaders(res, host);
    if (!isLocalNetworkAddress(ip)) {
      res.destroy();
      return;
    }
    if (!isAllowedHost(host)) {
      this.send(res, 421, { error: 'host-not-allowed' });
      return;
    }
    if (!this.httpLimiter.take(ip)) {
      res.setHeader('Retry-After', '10');
      this.send(res, 429, { error: 'rate-limited' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/info' && req.method === 'GET') {
      this.send(res, 200, { product: 'NOVA TV OS', name: this.handlers.tvName(), protocol: REMOTE_PROTOCOL_VERSION, pairingOpen: this.pairing.current !== null });
      return;
    }
    if (url.pathname === '/api/pair') {
      if (req.method !== 'POST') {
        this.send(res, 405, { error: 'method-not-allowed' });
        return;
      }
      void this.handlePair(req, res, ip);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.send(res, 405, { error: 'method-not-allowed' });
      return;
    }
    this.serveStatic(url.pathname, res);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      this.send(res, 400, { error: 'bad-path' });
      return;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.includes('\0')) {
      this.send(res, 400, { error: 'bad-path' });
      return;
    }
    const root = path.resolve(this.staticDir);
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      this.send(res, 404, { error: 'not-found' });
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        this.send(res, 404, { error: 'not-found' });
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
      fs.createReadStream(file).pipe(res);
    });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('too-large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse, ip: string): Promise<void> {
    if (!this.pairLimiter.take(ip)) {
      this.send(res, 429, { error: 'rate-limited' });
      return;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      this.send(res, 415, { error: 'json-required' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await this.readBody(req));
    } catch {
      this.send(res, 400, { error: 'invalid-json' });
      return;
    }
    const parsed = pairRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.send(res, 400, { error: 'invalid-request' });
      return;
    }
    const result = this.pairing.complete(parsed.data, this.handlers.tvName());
    if ('error' in result) {
      this.db.logEvent('pair-failed', `${result.error} from ${ip}`);
      this.emit('pairing-changed');
      const status = result.error === 'invalid-proof' ? 401 : result.error === 'locked' ? 423 : result.error === 'bad-key' ? 400 : 403;
      this.send(res, status, { error: result.error });
      return;
    }
    const stored = this.secrets.encrypt(result.secret.toString('base64'));
    this.db.addDevice({ id: result.deviceId, name: result.deviceName, secret: stored, protectedSecret: this.secrets.available });
    this.db.logEvent('pair-success', `${result.deviceName} (${result.deviceId.slice(0, 8)}) from ${ip}`);
    log.info('device paired', { name: result.deviceName });
    this.handlers.onPaired?.({ id: result.deviceId, name: result.deviceName });
    this.emit('pairing-changed');
    this.emit('devices-changed');
    this.send(res, 200, result.response);
  }

  // ---------------------------------------------------------------- WebSocket

  private sendWs(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private onSocket(ws: WebSocket, ip: string): void {
    const session: Session = {
      ws,
      ip,
      nonce: b64url(crypto.randomBytes(32)),
      deviceId: null,
      deviceName: null,
      key: null,
      lastSeq: 0,
      bucket: new TokenBucket(30, 15),
      dropped: 0,
      authTimer: null,
    };
    this.sessions.add(session);
    session.authTimer = setTimeout(() => {
      if (!session.key) ws.close(4408, 'authentication timeout');
    }, 10_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(4400, 'binary not supported');
        return;
      }
      void this.onMessage(session, data.toString());
    });
    ws.on('close', () => {
      if (session.authTimer) clearTimeout(session.authTimer);
      this.sessions.delete(session);
      if (session.deviceId) this.emit('devices-changed');
    });
    ws.on('error', () => ws.terminate());
    this.sendWs(ws, { t: 'challenge', v: REMOTE_PROTOCOL_VERSION, nonce: session.nonce, tvName: this.handlers.tvName() });
  }

  private deviceSecret(deviceId: string): Buffer | null {
    const d = this.db.device(deviceId);
    if (!d) return null;
    try {
      const plain = d.secret_protected ? this.secrets.decrypt(d.secret) : d.secret;
      const buf = Buffer.from(plain, 'base64');
      return buf.length === 32 ? buf : null;
    } catch {
      return null;
    }
  }

  private async onMessage(s: Session, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      s.ws.close(4400, 'invalid json');
      return;
    }
    if (!s.key) {
      const auth = authEnvelopeSchema.safeParse(msg);
      if (!auth.success) {
        s.ws.close(4400, 'expected auth');
        return;
      }
      const secret = this.deviceSecret(auth.data.deviceId);
      const expected = secret ? b64url(hmac(secret, authMessage(s.nonce, auth.data.deviceId))) : null;
      if (!secret || !expected || !timingSafeEqualB64(expected, auth.data.mac)) {
        this.authBan.fail(s.ip);
        this.db.logEvent('auth-failed', `device ${auth.data.deviceId.slice(0, 8)} from ${s.ip}`);
        this.sendWs(s.ws, { t: 'error', error: secret ? 'authentication failed' : 'unknown device — pair again' });
        s.ws.close(4401, 'unauthorized');
        return;
      }
      this.authBan.succeed(s.ip);
      const device = this.db.device(auth.data.deviceId)!;
      s.deviceId = device.id;
      s.deviceName = device.name;
      s.key = hmac(secret, sessionKeyMessage(s.nonce));
      if (s.authTimer) clearTimeout(s.authTimer);
      this.db.touchDevice(device.id);
      this.emit('devices-changed');
      this.sendWs(s.ws, { t: 'ready', state: this.handlers.nowPlaying() });
      return;
    }

    const env = commandEnvelopeSchema.safeParse(msg);
    if (!env.success) {
      this.sendWs(s.ws, { t: 'error', error: 'invalid envelope' });
      return;
    }
    const { seq, body, mac } = env.data;
    const expected = b64url(hmac(s.key, commandMessage(seq, body)));
    if (!timingSafeEqualB64(expected, mac)) {
      this.db.logEvent('mac-failed', `device ${s.deviceId?.slice(0, 8)} from ${s.ip}`);
      s.ws.close(4401, 'bad signature');
      return;
    }
    if (seq <= s.lastSeq) {
      // Replayed or reordered message.
      this.sendWs(s.ws, { t: 'ack', seq, ok: false, error: 'replay' });
      return;
    }
    s.lastSeq = seq;
    if (!s.bucket.take()) {
      s.dropped++;
      this.sendWs(s.ws, { t: 'ack', seq, ok: false, error: 'rate-limited' });
      if (s.dropped > 200) s.ws.close(4429, 'too many requests');
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      this.sendWs(s.ws, { t: 'ack', seq, ok: false, error: 'invalid json' });
      return;
    }
    const cmd = remoteCommandSchema.safeParse(parsedBody);
    if (!cmd.success) {
      this.sendWs(s.ws, { t: 'ack', seq, ok: false, error: 'invalid command' });
      return;
    }
    try {
      if (cmd.data.type === 'getState') this.sendWs(s.ws, { t: 'state', state: this.handlers.nowPlaying() });
      else await this.handlers.command(cmd.data, { id: s.deviceId!, name: s.deviceName ?? 'phone' });
      this.sendWs(s.ws, { t: 'ack', seq, ok: true });
    } catch (err) {
      this.sendWs(s.ws, { t: 'ack', seq, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' });
    }
  }

  /** Push now-playing state to all authenticated phones. */
  broadcastState(): void {
    if (!this.sessions.size) return;
    const state = this.handlers.nowPlaying();
    for (const s of this.sessions) if (s.key) this.sendWs(s.ws, { t: 'state', state });
  }

  revoke(deviceId: string): void {
    this.db.removeDevice(deviceId);
    this.db.logEvent('device-revoked', deviceId.slice(0, 8));
    for (const s of this.sessions) {
      if (s.deviceId === deviceId) {
        this.sendWs(s.ws, { t: 'revoked' });
        s.ws.close(4403, 'revoked');
      }
    }
    this.emit('devices-changed');
  }
}
