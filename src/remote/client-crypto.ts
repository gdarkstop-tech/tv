import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import {
  authMessage,
  commandMessage,
  deviceSecretInfo,
  pairClientMessage,
  pairServerMessage,
  REMOTE_PROTOCOL_VERSION,
  sessionKeyMessage,
  type PairResponse,
  type RemoteCommand,
} from '../shared/remote-protocol';

// Phone-side protocol implementation. Uses audited pure-JS crypto (@noble)
// because WebCrypto is unavailable on plain-HTTP LAN pages in Safari.

const enc = new TextEncoder();

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mac(key: Uint8Array, message: string): string {
  return toB64url(hmac(sha256, key, enc.encode(message)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Credentials {
  deviceId: string;
  secret: string; // base64url, 32 bytes
  tvName: string;
}

export class PairingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Run the pairing handshake against `baseUrl` (e.g. "http://192.168.1.20:8730"). */
export async function pairDevice(baseUrl: string, code: string, deviceName: string, fetchFn: typeof fetch = fetch): Promise<Credentials> {
  const digits = code.replace(/\D/g, '');
  if (digits.length !== 6) throw new PairingError('format', 'Enter the 6-digit code shown on the TV.');
  const priv = x25519.utils.randomPrivateKey();
  const pub = toB64url(x25519.getPublicKey(priv));
  const codeKey = enc.encode(digits);
  const res = await fetchFn(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, clientPublicKey: pub, deviceName, proof: mac(codeKey, pairClientMessage(pub)) }),
  });
  if (!res.ok) {
    let err = 'failed';
    try {
      err = ((await res.json()) as { error?: string }).error ?? err;
    } catch {
      // ignore
    }
    const messages: Record<string, string> = {
      'invalid-proof': 'That code is not correct. Check the code on the TV and try again.',
      locked: 'Too many wrong codes. Start pairing again on the TV.',
      expired: 'The code expired. Start pairing again on the TV.',
      closed: 'Pairing is not open. On the TV, open Settings → Remote & Devices → Pair a phone.',
      'rate-limited': 'Too many attempts. Wait a minute and try again.',
    };
    throw new PairingError(err, messages[err] ?? `Pairing failed (${err}).`);
  }
  const body = (await res.json()) as PairResponse;
  const expected = mac(codeKey, pairServerMessage(body.serverPublicKey, pub, body.deviceId));
  if (!constantTimeEqual(expected, body.serverProof)) throw new PairingError('server-proof', 'The TV could not prove it knows the code. Pairing aborted.');
  const shared = x25519.getSharedSecret(priv, fromB64url(body.serverPublicKey));
  const secret = hkdf(sha256, shared, codeKey, enc.encode(deviceSecretInfo(body.deviceId)), 32);
  return { deviceId: body.deviceId, secret: toB64url(secret), tvName: body.tvName };
}

export function authResponse(creds: Credentials, nonce: string): { t: 'auth'; deviceId: string; mac: string } {
  return { t: 'auth', deviceId: creds.deviceId, mac: mac(fromB64url(creds.secret), authMessage(nonce, creds.deviceId)) };
}

/** Signs commands for one authenticated WebSocket session. */
export class CommandSigner {
  private seq = 0;
  private readonly key: Uint8Array;

  constructor(creds: Credentials, nonce: string) {
    this.key = hmac(sha256, fromB64url(creds.secret), enc.encode(sessionKeyMessage(nonce)));
  }

  sign(cmd: RemoteCommand): { t: 'cmd'; seq: number; body: string; mac: string } {
    const seq = ++this.seq;
    const body = JSON.stringify(cmd);
    return { t: 'cmd', seq, body, mac: mac(this.key, commandMessage(seq, body)) };
  }
}
