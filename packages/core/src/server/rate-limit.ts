/**
 * In-memory sliding-window rate limiter. Keeps a bounded list of hit
 * timestamps per key; a key is over the limit when it already has `limit` hits
 * inside the window. The clock (`now`) is passed in so it is deterministic and
 * unit-testable.
 */
export function createRateLimiter() {
  const hits = new Map<string, number[]>();
  return {
    check(
      key: string,
      limit: number,
      windowMs: number,
      now: number,
    ): { allowed: boolean; remaining: number } {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, remaining: 0 };
      }
      recent.push(now);
      hits.set(key, recent);
      return { allowed: true, remaining: limit - recent.length };
    },
  };
}
