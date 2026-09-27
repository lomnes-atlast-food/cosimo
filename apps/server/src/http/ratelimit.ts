/** In-memory fixed-window rate limiter (single process by design, SPEC §4.1). */
export class RateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();

  /** Returns seconds to wait if limited, otherwise 0. */
  hit(key: string, limit: number, windowMs: number): number {
    const now = Date.now();
    let b = this.#buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.#buckets.set(key, b);
    }
    b.count++;
    if (this.#buckets.size > 10_000) {
      for (const [k, v] of this.#buckets) if (v.resetAt <= now) this.#buckets.delete(k);
    }
    return b.count > limit ? Math.ceil((b.resetAt - now) / 1000) : 0;
  }

  reset() {
    this.#buckets.clear();
  }
}
