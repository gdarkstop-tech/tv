import os from 'node:os';

// Network helpers that keep the phone remote local-network only.

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Strip the IPv4-mapped IPv6 prefix Node uses for dual-stack sockets. */
export function normalizeAddress(addr: string | undefined | null): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopback(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (a === '::1') return true;
  const n = ipv4ToInt(a);
  return n !== null && inRange(n, '127.0.0.0', 8);
}

/**
 * True for addresses that can only originate from the local network:
 * RFC 1918, link-local, CGNAT (often used by tethering), loopback and
 * IPv6 unique-local / link-local.
 */
export function isLocalNetworkAddress(addr: string | undefined | null): boolean {
  const a = normalizeAddress(addr).toLowerCase();
  if (!a) return false;
  if (a.includes(':')) {
    return a === '::1' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd');
  }
  const n = ipv4ToInt(a);
  if (n === null) return false;
  return (
    inRange(n, '10.0.0.0', 8) ||
    inRange(n, '172.16.0.0', 12) ||
    inRange(n, '192.168.0.0', 16) ||
    inRange(n, '169.254.0.0', 16) ||
    inRange(n, '100.64.0.0', 10) ||
    inRange(n, '127.0.0.0', 8)
  );
}

export interface LocalAddress {
  iface: string;
  address: string;
}

export function privateIpv4Addresses(): LocalAddress[] {
  const out: LocalAddress[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (!isLocalNetworkAddress(i.address) || i.address.startsWith('169.254.')) continue;
      out.push({ iface: name, address: i.address });
    }
  }
  // Prefer typical home LAN ranges first.
  return out.sort((a, b) => Number(!a.address.startsWith('192.168.')) - Number(!b.address.startsWith('192.168.')));
}

/**
 * Validate the Host header to defeat DNS-rebinding: only IP literals on the
 * local network, localhost, and this machine's .local name are accepted.
 */
export function isAllowedHost(hostHeader: string | undefined, hostname = os.hostname()): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost') return true;
  if (ipv4ToInt(host) !== null) return isLocalNetworkAddress(host);
  if (host.includes(':')) return isLocalNetworkAddress(host);
  const local = `${hostname.toLowerCase()}.local`;
  return host === local || host === hostname.toLowerCase();
}
