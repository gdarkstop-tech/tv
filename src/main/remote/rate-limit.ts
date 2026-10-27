// Token-bucket rate limiting keyed by client (IP or session).

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now = Date.now(), cost = 1): boolean {
    const elapsed = Math.max(0, (now - this.last) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.last = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
}

export class KeyedRateLimiter {
  private buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly maxKeys = 1000,
  ) {}

  take(key: string, now = Date.now()): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) this.evict(now);
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSecond, now), seen: now };
      this.buckets.set(key, entry);
    }
    entry.seen = now;
    return entry.bucket.take(now);
  }

  private evict(now: number): void {
    for (const [k, v] of this.buckets) if (now - v.seen > 10 * 60_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = [...this.buckets.entries()].sort((a, b) => a[1].seen - b[1].seen).slice(0, Math.ceil(this.maxKeys / 10));
      for (const [k] of oldest) this.buckets.delete(k);
    }
  }
}

/** Temporarily blocks keys after repeated failures (e.g. bad authentication). */
export class FailureBan {
  private failures = new Map<string, { count: number; first: number; bannedUntil: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly banMs: number,
  ) {}

  isBanned(key: string, now = Date.now()): boolean {
    const f = this.failures.get(key);
    return Boolean(f && f.bannedUntil > now);
  }

  fail(key: string, now = Date.now()): boolean {
    let f = this.failures.get(key);
    if (!f || now - f.first > this.windowMs) {
      f = { count: 0, first: now, bannedUntil: 0 };
      this.failures.set(key, f);
    }
    f.count++;
    if (f.count >= this.maxFailures) f.bannedUntil = now + this.banMs;
    if (this.failures.size > 5000) this.failures.clear();
    return f.bannedUntil > now;
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
