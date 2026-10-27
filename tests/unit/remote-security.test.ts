import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { NovaDatabase } from '../../src/main/db';
import { isAllowedHost, isLocalNetworkAddress } from '../../src/main/remote/net';
import { PairingManager } from '../../src/main/remote/pairing';
import { FailureBan, TokenBucket } from '../../src/main/remote/rate-limit';
import { RemoteServer } from '../../src/main/remote/remote-server';
import { authResponse, CommandSigner, pairDevice, PairingError, type Credentials } from '../../src/remote/client-crypto';
import type { RemoteCommand, ServerMessage } from '../../src/shared/remote-protocol';

describe('network guards', () => {
  it('accepts only local-network addresses', () => {
    for (const ip of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '127.0.0.1', '::ffff:192.168.0.9', '169.254.3.3', 'fe80::1', 'fd12::3', '::1']) {
      expect(isLocalNetworkAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2001:4860::8888', '::ffff:8.8.4.4', '', 'garbage']) {
      expect(isLocalNetworkAddress(ip), ip).toBe(false);
    }
  });

  it('blocks DNS-rebinding host names', () => {
    expect(isAllowedHost('192.168.1.10:8730')).toBe(true);
    expect(isAllowedHost('localhost:8730')).toBe(true);
    expect(isAllowedHost('mylaptop.local:8730', 'MyLaptop')).toBe(true);
    expect(isAllowedHost('evil.example.com:8730')).toBe(false);
    expect(isAllowedHost('8.8.8.8:8730')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it('rate limits with a token bucket and bans repeated failures', () => {
    const b = new TokenBucket(3, 1, 0);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.take(1500)).toBe(true);
    const ban = new FailureBan(3, 60_000, 300_000);
    expect(ban.fail('a', 0)).toBe(false);
    expect(ban.fail('a', 1)).toBe(false);
    expect(ban.fail('a', 2)).toBe(true);
    expect(ban.isBanned('a', 100_000)).toBe(true);
    expect(ban.isBanned('a', 400_000)).toBe(false);
  });
});

describe('pairing request rate limit', () => {
  it('limits pairing attempts per address', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-remote-rl-'));
    fs.mkdirSync(path.join(dir, 'static'));
    const db = new NovaDatabase(path.join(dir, 'nova.db'));
    const srv = new RemoteServer(db, path.join(dir, 'static'), {
      tvName: () => 'TV',
      nowPlaying: () => ({ tvName: 'TV', status: 'idle', title: null, kind: null, position: 0, duration: 0, paused: false, volume: 100, muted: false, pictureMode: 'auto', audioTracks: [], subtitleTracks: [], screen: 'home' }),
      command: async () => undefined,
    });
    await srv.start(0, '127.0.0.1');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      statuses.push(r.status);
    }
    await srv.stop();
    db.close();
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('pairing codes', () => {
  it('expire after two minutes and are single-use', () => {
    let now = 0;
    const p = new PairingManager(() => now);
    const { code } = p.open();
    expect(code).toMatch(/^\d{6}$/);
    now = 121_000;
    expect(p.current).toBeNull();
  });
});

describe('RemoteServer end-to-end security', () => {
  let dir: string;
  let db: NovaDatabase;
  let server: RemoteServer;
  let base: string;
  const received: RemoteCommand[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-remote-'));
    const staticDir = path.join(dir, 'static');
    fs.mkdirSync(staticDir);
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>remote</title>');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
    db = new NovaDatabase(path.join(dir, 'nova.db'));
    server = new RemoteServer(db, staticDir, {
      tvName: () => "ALIA'S FAMILY",
      nowPlaying: () => ({ tvName: "ALIA'S FAMILY", status: 'idle', title: null, kind: null, position: 0, duration: 0, paused: false, volume: 100, muted: false, pictureMode: 'auto', audioTracks: [], subtitleTracks: [], screen: 'home' }),
      command: async (cmd) => {
        received.push(cmd);
      },
    }, undefined, { pairRequestsPerMinute: 1000 });
    await server.start(0, '127.0.0.1');
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.stop();
    db.close();
  });

  beforeEach(() => {
    received.length = 0;
  });

  const openSocket = () =>
    new Promise<{ ws: WebSocket; nonce: string; next: () => Promise<ServerMessage> }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const queue: ServerMessage[] = [];
      const waiters: Array<(m: ServerMessage) => void> = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMessage;
        const w = waiters.shift();
        if (w) w(m);
        else queue.push(m);
      });
      const next = () => new Promise<ServerMessage>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r)));
      ws.on('error', reject);
      ws.on('open', async () => {
        const first = await next();
        if (first.t !== 'challenge') reject(new Error('no challenge'));
        else resolve({ ws, nonce: first.nonce, next });
      });
    });

  const closeCode = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));

  async function pair(): Promise<Credentials> {
    const { code } = server.pairing.open();
    return pairDevice(base, code, 'Test iPhone');
  }

  it('serves the remote page with strict security headers and no path traversal', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const trav = await fetch(`${base}/..%2fsecret.txt`);
    expect(trav.status).toBe(404);
    const info = await (await fetch(`${base}/api/info`)).json();
    expect(info).toMatchObject({ name: "ALIA'S FAMILY", pairingOpen: false });
  });

  it('refuses pairing when the TV has not opened a pairing window', async () => {
    server.pairing.close();
    await expect(pairDevice(base, '123456', 'x')).rejects.toMatchObject({ code: 'closed' });
  });

  it('rejects wrong codes and locks after five attempts', async () => {
    const { code } = server.pairing.open();
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 4; i++) await expect(pairDevice(base, wrong, 'attacker')).rejects.toMatchObject({ code: 'invalid-proof' });
    await expect(pairDevice(base, wrong, 'attacker')).rejects.toMatchObject({ code: 'locked' });
    // The correct code no longer works: the window was invalidated.
    await expect(pairDevice(base, code, 'late')).rejects.toBeInstanceOf(PairingError);
    expect(db.devices()).toHaveLength(0);
  });

  it('rejects malformed pairing requests', async () => {
    server.pairing.open();
    const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, evil: true }) });
    expect(res.status).toBe(400);
    const notJson = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(notJson.status).toBe(415);
  });

  it('pairs with the correct code, derives matching secrets, and the code is single-use', async () => {
    const { code } = server.pairing.open();
    const creds = await pairDevice(base, code, 'Ali iPhone');
    expect(creds.deviceId).toMatch(/^[a-f0-9]{32}$/);
    expect(creds.tvName).toBe("ALIA'S FAMILY");
    // The secret itself never appears in the server's response or the database in a different form.
    const stored = db.device(creds.deviceId)!;
    expect(Buffer.from(stored.secret, 'base64').toString('base64url')).toBe(creds.secret);
    await expect(pairDevice(base, code, 'second')).rejects.toMatchObject({ code: 'closed' });
  });

  it('authenticates a paired device and executes signed commands', async () => {
    const creds = await pair();
    const { ws, nonce, next } = await openSocket();
    ws.send(JSON.stringify(authResponse(creds, nonce)));
    expect((await next()).t).toBe('ready');
    const signer = new CommandSigner(creds, nonce);
    ws.send(JSON.stringify(signer.sign({ type: 'key', key: 'down' })));
    expect(await next()).toMatchObject({ t: 'ack', ok: true });
    ws.send(JSON.stringify(signer.sign({ type: 'playback', action: 'toggle' })));
    expect(await next()).toMatchObject({ t: 'ack', ok: true });
    expect(received).toEqual([{ type: 'key', key: 'down' }, { type: 'playback', action: 'toggle' }]);
    ws.close();
  });

  it('rejects an unknown device and a wrong secret', async () => {
    const creds = await pair();
    const forged: Credentials = { ...creds, secret: Buffer.alloc(32, 7).toString('base64url') };
    const { ws, nonce, next } = await openSocket();
    const closed = closeCode(ws);
    ws.send(JSON.stringify(authResponse(forged, nonce)));
    expect(await next()).toMatchObject({ t: 'error' });
    expect(await closed).toBe(4401);
    expect(received).toEqual([]);
  });

  it('rejects replayed, tampered and invalid commands', async () => {
    const creds = await pair();
    const { ws, nonce, next } = await openSocket();
    ws.send(JSON.stringify(authResponse(creds, nonce)));
    await next();
    const signer = new CommandSigner(creds, nonce);
    const msg = signer.sign({ type: 'volume', action: 'up' });
    ws.send(JSON.stringify(msg));
    expect(await next()).toMatchObject({ ok: true });
    ws.send(JSON.stringify(msg)); // replay
    expect(await next()).toMatchObject({ ok: false, error: 'replay' });
    // Schema violations are signed correctly but still rejected.
    const bad = signer.sign({ type: 'key', key: 'reboot' } as unknown as RemoteCommand);
    ws.send(JSON.stringify(bad));
    expect(await next()).toMatchObject({ ok: false, error: 'invalid command' });
    const shell = signer.sign({ type: 'exec', cmd: 'rm -rf /' } as unknown as RemoteCommand);
    ws.send(JSON.stringify(shell));
    expect(await next()).toMatchObject({ ok: false, error: 'invalid command' });
    // Tampering with the body invalidates the signature and closes the session.
    const tampered = signer.sign({ type: 'volume', action: 'down' });
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ ...tampered, body: JSON.stringify({ type: 'volume', action: 'set', value: 130 }) }));
    expect(await closed).toBe(4401);
    expect(received).toEqual([{ type: 'volume', action: 'up' }]);
  });

  it('rejects commands before authentication', async () => {
    const { ws } = await openSocket();
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ t: 'cmd', seq: 1, body: '{"type":"key","key":"up"}', mac: 'A'.repeat(43) }));
    expect(await closed).toBe(4400);
    expect(received).toEqual([]);
  });

  it('rate limits floods of commands', async () => {
    const creds = await pair();
    const { ws, nonce, next } = await openSocket();
    ws.send(JSON.stringify(authResponse(creds, nonce)));
    await next();
    const signer = new CommandSigner(creds, nonce);
    for (let i = 0; i < 60; i++) ws.send(JSON.stringify(signer.sign({ type: 'key', key: 'right' })));
    const acks: ServerMessage[] = [];
    for (let i = 0; i < 60; i++) acks.push(await next());
    const limited = acks.filter((a) => a.t === 'ack' && !a.ok && a.error === 'rate-limited').length;
    expect(limited).toBeGreaterThan(20);
    ws.close();
  });

  it('rejects cross-site WebSocket origins', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: 'http://evil.example.com' } });
    const err = await new Promise<string>((r) => ws.on('error', (e) => r(String(e))));
    expect(err).toMatch(/403/);
  });

  it('revoking a device disconnects it and blocks re-authentication', async () => {
    const creds = await pair();
    const { ws, nonce, next } = await openSocket();
    ws.send(JSON.stringify(authResponse(creds, nonce)));
    await next();
    const closed = closeCode(ws);
    server.revoke(creds.deviceId);
    expect(await next()).toMatchObject({ t: 'revoked' });
    expect(await closed).toBe(4403);
    const again = await openSocket();
    const closed2 = closeCode(again.ws);
    again.ws.send(JSON.stringify(authResponse(creds, again.nonce)));
    expect(await again.next()).toMatchObject({ t: 'error' });
    expect(await closed2).toBe(4401);
  });
});
