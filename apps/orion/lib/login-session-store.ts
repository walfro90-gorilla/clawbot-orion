/**
 * In-memory session ownership cache for the remote-browser login flow.
 *
 * Why: each /frame request fires ~8x/sec. Doing a Supabase JWT verify + a
 * profiles lookup on every request added 100-200ms of overhead per frame and
 * dominated the user-perceived latency. We register ownership ONCE on session
 * start and cheap-check it on every subsequent request.
 *
 * Security: the sessionId is a UUID returned only to the user who started the
 * session. Without it, requests cannot be made (the cookie-server itself
 * rejects unknown ids). The cache only short-circuits the redundant auth check
 * that already happened on session creation.
 *
 * Lifecycle: entries expire after 20 min (slightly longer than cookie-server's
 * 15-min hard TTL). A cleanup sweep runs every minute.
 */
type Owner = {
  userId:    string
  accountId: string
  expiresAt: number
}

// `globalThis` keeps the Map alive across hot-reloads in dev.
const g = globalThis as unknown as { __loginSessionOwners?: Map<string, Owner> }
if (!g.__loginSessionOwners) g.__loginSessionOwners = new Map()
const owners = g.__loginSessionOwners

const TTL_MS = 20 * 60 * 1000

export function registerSession(sessionId: string, userId: string, accountId: string) {
  owners.set(sessionId, {
    userId,
    accountId,
    expiresAt: Date.now() + TTL_MS,
  })
}

export function dropSession(sessionId: string) {
  owners.delete(sessionId)
}

/** Returns userId if the sessionId is owned by someone with access to accountId. Else null. */
export function checkSessionAccess(sessionId: string, accountId: string): string | null {
  const o = owners.get(sessionId)
  if (!o)                            return null
  if (o.expiresAt < Date.now())      { owners.delete(sessionId); return null }
  if (o.accountId !== accountId)     return null
  return o.userId
}

// Periodic GC to prevent unbounded growth on long-running servers
const g2 = globalThis as unknown as { __loginSessionGC?: NodeJS.Timeout }
if (!g2.__loginSessionGC) {
  g2.__loginSessionGC = setInterval(() => {
    const now = Date.now()
    for (const [sid, o] of owners) {
      if (o.expiresAt < now) owners.delete(sid)
    }
  }, 60_000)
}
