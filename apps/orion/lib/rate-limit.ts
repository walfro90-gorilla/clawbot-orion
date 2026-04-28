// Simple in-memory rate limiter — per key, per window
// Not shared across processes; good enough for single-server setup.

interface RateEntry { count: number; windowStart: number }
const store = new Map<string, RateEntry>()

export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now - entry.windowStart > windowMs) {
    store.set(key, { count: 1, windowStart: now })
    return { ok: true, retryAfterMs: 0 }
  }

  if (entry.count >= maxRequests) {
    const retryAfterMs = windowMs - (now - entry.windowStart)
    return { ok: false, retryAfterMs }
  }

  entry.count++
  return { ok: true, retryAfterMs: 0 }
}
