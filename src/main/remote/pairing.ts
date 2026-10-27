import crypto from 'node:crypto';
import {
  deviceSecretInfo,
  pairClientMessage,
  pairServerMessage,
  type PairRequest,
  type PairResponse,
} from '../../shared/remote-protocol';

// One-time pairing: the TV shows a short code; the phone proves knowledge of
// it while both sides run an X25519 key agreement. The resulting device
// secret is derived independently on each side and never sent on the wire.

export const PAIRING_TTL_MS = 2 * 60_000;
export const MAX_PAIRING_ATTEMPTS = 5;

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function hmac(key: Buffer | string, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

export function timingSafeEqualB64(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64url');
  const y = Buffer.from(b, 'base64url');
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

export interface PairingResult {
  response: PairResponse;
  deviceId: string;
  deviceName: string;
  secret: Buffer;
}

export type PairingFailure = { error: 'closed' | 'expired' | 'invalid-proof' | 'locked' | 'bad-key' };

export class PairingManager {
  private code: string | null = null;
  private expiresAt = 0;
  private attempts = 0;

  constructor(private readonly now: () => number = Date.now) {}

  open(): { code: string; expiresAt: number } {
    // 6 digits from a CSPRNG, avoiding visually ambiguous repeats is unnecessary for digits.
    this.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.expiresAt = this.now() + PAIRING_TTL_MS;
    this.attempts = 0;
    return { code: this.code, expiresAt: this.expiresAt };
  }

  close(): void {
    this.code = null;
    this.expiresAt = 0;
    this.attempts = 0;
  }

  get current(): { code: string; expiresAt: number } | null {
    if (!this.code) return null;
    if (this.now() > this.expiresAt) {
      this.close();
      return null;
    }
    return { code: this.code, expiresAt: this.expiresAt };
  }

  complete(req: PairRequest, tvName: string): PairingResult | PairingFailure {
    if (this.code && this.now() > this.expiresAt) {
      this.close();
      return { error: 'expired' };
    }
    const cur = this.current;
    if (!cur) return { error: 'closed' };
    const expected = b64url(hmac(cur.code, pairClientMessage(req.clientPublicKey)));
    if (!timingSafeEqualB64(expected, req.proof)) {
      this.attempts++;
      if (this.attempts >= MAX_PAIRING_ATTEMPTS) {
        // Too many wrong codes: invalidate this code entirely.
        this.close();
        return { error: 'locked' };
      }
      return { error: 'invalid-proof' };
    }
    let clientKey: crypto.KeyObject;
    try {
      const raw = Buffer.from(req.clientPublicKey, 'base64url');
      if (raw.length !== 32) return { error: 'bad-key' };
      clientKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: req.clientPublicKey }, format: 'jwk' });
    } catch {
      return { error: 'bad-key' };
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const serverPub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    let shared: Buffer;
    try {
      shared = crypto.diffieHellman({ privateKey, publicKey: clientKey });
    } catch {
      return { error: 'bad-key' };
    }
    // Reject low-order points (all-zero shared secret).
    if (shared.every((b) => b === 0)) return { error: 'bad-key' };
    const deviceId = crypto.randomBytes(16).toString('hex');
    const secret = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(cur.code, 'utf8'), Buffer.from(deviceSecretInfo(deviceId), 'utf8'), 32));
    const serverProof = b64url(hmac(cur.code, pairServerMessage(serverPub, req.clientPublicKey, deviceId)));
    this.close(); // single use
    return {
      deviceId,
      deviceName: req.deviceName,
      secret,
      response: { deviceId, serverPublicKey: serverPub, serverProof, tvName },
    };
  }
}
