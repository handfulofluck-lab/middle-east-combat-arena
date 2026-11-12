// Token buckets. `take(n)` succeeds while the bucket holds n tokens; tokens
// refill continuously at `ratePerSec` up to `burst`. Time is injected so the
// buckets are deterministic under test.

export class TokenBucket {
  constructor(ratePerSec, burst, now = Date.now()) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  refill(now) {
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
    }
  }

  take(n = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  // seconds until n tokens are available (for Retry-After)
  retryAfter(n = 1, now = Date.now()) {
    this.refill(now);
    if (this.tokens >= n) return 0;
    return Math.ceil((n - this.tokens) / this.rate);
  }
}

// One bucket per key (IP address, ...), with a hard bound on memory: when the
// table is full, refilled (idle) buckets are swept first and, if that is not
// enough, the oldest entries are evicted.
export class KeyedLimiter {
  constructor({ ratePerSec, burst, maxKeys = 20000 }) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  _bucket(key, now) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now, true);
      b = new TokenBucket(this.rate, this.burst, now);
      this.buckets.set(key, b);
    }
    return b;
  }

  take(key, n = 1, now = Date.now()) {
    return this._bucket(key, now).take(n, now);
  }

  // true when the key still has budget, WITHOUT consuming any
  peek(key, n = 1, now = Date.now()) {
    const b = this.buckets.get(key);
    if (!b) return true;
    b.refill(now);
    return b.tokens >= n;
  }

  retryAfter(key, n = 1, now = Date.now()) {
    const b = this.buckets.get(key);
    return b ? b.retryAfter(n, now) : 0;
  }

  sweep(now = Date.now(), force = false) {
    for (const [key, b] of this.buckets) {
      b.refill(now);
      if (b.tokens >= b.burst) this.buckets.delete(key);
    }
    if (force && this.buckets.size >= this.maxKeys) {
      let drop = Math.ceil(this.maxKeys / 10);
      for (const key of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(key);
      }
    }
  }
}
