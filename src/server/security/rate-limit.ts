/**
 * Fixed-window in-process rate limiter. Adequate for a single web instance;
 * a multi-instance deployment should move this to Postgres or Redis.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) sweep(now);
    return { ok: true, retryAfterMs: 0 };
  }
  b.count += 1;
  return b.count <= limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: b.resetAt - now };
}

function sweep(now: number) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}
