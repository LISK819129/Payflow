/**
 * Fixed-window in-process rate limiter. Adequate for a single web instance;
 * a multi-instance deployment should move this to Postgres or Redis.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function live(key: string, now: number): Bucket | undefined {
  const b = buckets.get(key);
  if (b && b.resetAt <= now) {
    buckets.delete(key);
    return undefined;
  }
  return b;
}

/** Counts this call and reports whether the caller is over the limit. */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = live(key, now) ?? { count: 0, resetAt: now + windowMs };
  b.count += 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) sweep(now);
  return b.count <= limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: b.resetAt - now };
}

/** Whether `key` has already reached `limit` hits in its window, without counting a new one. */
export function isLimited(key: string, limit: number): boolean {
  const b = live(key, Date.now());
  return !!b && b.count >= limit;
}

/** Records one hit (e.g. a failed sign-in) against `key`. */
export function recordHit(key: string, windowMs: number) {
  rateLimit(key, Number.MAX_SAFE_INTEGER, windowMs);
}

export function clearHits(key: string) {
  buckets.delete(key);
}

function sweep(now: number) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}
